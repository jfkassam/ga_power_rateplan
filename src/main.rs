use std::collections::HashMap;
use std::error::Error;
use std::fs::File;
use std::io::{BufRead, BufReader};

use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};
use csv::{ReaderBuilder, Trim};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct UsageRecord {
    #[serde(rename = "Hour")]
    timestamp_str: String,
    #[serde(rename = "kWh")]
    kwh: f64,
}

#[derive(Debug)]
struct DailyUsage {
    date: NaiveDate,
    // For TOU-REO & TOU-RD (shared classification):
    tou_reo_on: f64,
    tou_reo_off: f64,
    // For TOU-OA, separate classification:
    tou_oa_on: f64,
    tou_oa_off: f64,
    tou_oa_super: f64,
    // For R-30: total daily usage
    total: f64,
}

impl DailyUsage {
    fn new(date: NaiveDate) -> Self {
        Self {
            date,
            tou_reo_on: 0.0,
            tou_reo_off: 0.0,
            tou_oa_on: 0.0,
            tou_oa_off: 0.0,
            tou_oa_super: 0.0,
            total: 0.0,
        }
    }
}

// For TOU-REO & TOU-RD: on-peak is defined as Monday–Friday (weekday 0–4)
// in June–September between 14:00 and 19:00.
fn is_on_peak(dt: &NaiveDateTime) -> bool {
    let month = dt.date().month();
    let hour = dt.hour();
    let weekday = dt.weekday().num_days_from_monday();
    (weekday < 5) && (month >= 6 && month <= 9) && (hour >= 14 && hour < 19)
}

// For TOU-OA: super off-peak is defined as 23:00 to 07:00.
fn is_super_off_peak(dt: &NaiveDateTime) -> bool {
    let hour = dt.hour();
    hour >= 23 || hour < 7
}

fn period_tou_oa(dt: &NaiveDateTime) -> &'static str {
    if is_on_peak(dt) {
        "on_peak"
    } else if is_super_off_peak(dt) {
        "super_off_peak"
    } else {
        "off_peak"
    }
}

// Parse timestamp from format "%Y-%m-%d %H:%M"
fn parse_timestamp(s: &str) -> Result<NaiveDateTime, chrono::ParseError> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M")
}

fn main() -> Result<(), Box<dyn Error>> {
    // Use a wide date range so all data is included.
    let start_date = NaiveDate::from_ymd(2024, 4, 1);
    let end_date   = NaiveDate::from_ymd(2025, 1, 31);

    // Open CSV file and skip the first two lines (e.g. disclaimers).
    let file = File::open("usage.csv")?;
    let mut reader = BufReader::new(file);
    let mut dummy = String::new();
    for _ in 0..2 {
        reader.read_line(&mut dummy)?;
        dummy.clear();
    }

    let mut csv_reader = ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .trim(Trim::All)
        .from_reader(reader);

    // Aggregate daily usage in a HashMap keyed by date.
    let mut daily_usage_map: HashMap<NaiveDate, DailyUsage> = HashMap::new();
    // Instead of one global max, we compute monthly max per billing month.
    let mut monthly_max: HashMap<(i32, u32), f64> = HashMap::new();

    for result in csv_reader.deserialize() {
        let record: UsageRecord = match result {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Skipping invalid record: {}", e);
                continue;
            }
        };
        let dt = match parse_timestamp(&record.timestamp_str) {
            Ok(dt) => dt,
            Err(e) => {
                eprintln!("Skipping invalid timestamp '{}': {}", record.timestamp_str, e);
                continue;
            }
        };

        if dt.date() < start_date || dt.date() > end_date {
            continue;
        }

        // Update monthly maximum for demand charge.
        let key = (dt.date().year(), dt.date().month());
        monthly_max
            .entry(key)
            .and_modify(|m| {
                if record.kwh > *m {
                    *m = record.kwh;
                }
            })
            .or_insert(record.kwh);

        let entry = daily_usage_map.entry(dt.date()).or_insert(DailyUsage::new(dt.date()));
        entry.total += record.kwh;
        // TOU-REO & TOU-RD classification.
        if is_on_peak(&dt) {
            entry.tou_reo_on += record.kwh;
        } else {
            entry.tou_reo_off += record.kwh;
        }
        // TOU-OA classification.
        match period_tou_oa(&dt) {
            "on_peak" => entry.tou_oa_on += record.kwh,
            "super_off_peak" => entry.tou_oa_super += record.kwh,
            "off_peak" => entry.tou_oa_off += record.kwh,
            _ => {}
        }
    }

    // Billing days (number of unique days with usage).
    let billing_days = daily_usage_map.len() as f64;

    // Compute aggregated diagnostics for TOU-REO and TOU-OA.
    let agg_tou_reo_on: f64 = daily_usage_map.values().map(|d| d.tou_reo_on).sum();
    let agg_tou_reo_off: f64 = daily_usage_map.values().map(|d| d.tou_reo_off).sum();
    let agg_tou_oa_on: f64 = daily_usage_map.values().map(|d| d.tou_oa_on).sum();
    let agg_tou_oa_off: f64 = daily_usage_map.values().map(|d| d.tou_oa_off).sum();
    let agg_tou_oa_super: f64 = daily_usage_map.values().map(|d| d.tou_oa_super).sum();

    // For R-30, group usage by (year, month). Assume billing is monthly.
    let mut r30_by_month: HashMap<(i32, u32), (f64, usize)> = HashMap::new();
    for (date, usage) in &daily_usage_map {
        let key = (date.year(), date.month());
        let entry = r30_by_month.entry(key).or_insert((0.0, 0));
        entry.0 += usage.total;
        entry.1 += 1;
    }

    // Compute monthly breakdown details for R-30.
    // Each detail: (year, month, tier1, tier2, tier3, fixed_charge, energy_cost, monthly_total, total_usage)
    let mut r30_breakdown_details = Vec::new();
    for (&(year, month), &(total_usage, day_count)) in &r30_by_month {
        let fixed = 0.4603 * (day_count as f64);
        let (tier1, tier2, tier3, energy_cost);
        if month >= 6 && month <= 9 {
            // Summer: tiered pricing.
            tier1 = total_usage.min(650.0);
            tier2 = if total_usage > 650.0 {
                (total_usage - 650.0).min(350.0)
            } else { 0.0 };
            tier3 = if total_usage > 1000.0 {
                total_usage - 1000.0
            } else { 0.0 };
            energy_cost = tier1 * 0.086121 + tier2 * 0.143047 + tier3 * 0.148051;
        } else {
            // Winter: single rate.
            tier1 = total_usage;
            tier2 = 0.0;
            tier3 = 0.0;
            energy_cost = total_usage * 0.080602;
        }
        let monthly_total = fixed + energy_cost;
        r30_breakdown_details.push((year, month, tier1, tier2, tier3, fixed, energy_cost, monthly_total, total_usage));
    }

    // Sort the monthly breakdown chronologically.
    r30_breakdown_details.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));

    // --- Compute final bill totals for each plan ---
    // TOU-REO (Time-of-Use – Residential Energy Only)
    let tou_reo_fixed = 0.4603 * billing_days;
    let tou_reo_energy_on = agg_tou_reo_on * 0.297868;
    let tou_reo_energy_off = agg_tou_reo_off * 0.076281;
    let tou_reo_total = tou_reo_fixed + tou_reo_energy_on + tou_reo_energy_off;

    // TOU-OA (Time-of-Use – Overnight Advantage)
    let tou_oa_fixed = 0.4603 * billing_days;
    let tou_oa_energy_on = agg_tou_oa_on * 0.297868;
    let tou_oa_energy_off = agg_tou_oa_off * 0.101676;
    let tou_oa_energy_super = agg_tou_oa_super * 0.021859;
    let tou_oa_total = tou_oa_fixed + tou_oa_energy_on + tou_oa_energy_off + tou_oa_energy_super;

    // TOU-RD (Time-of-Use – Residential Demand)
    let tou_rd_fixed = 0.4603 * billing_days;
    let tou_rd_energy_on = agg_tou_reo_on * 0.142986;
    let tou_rd_energy_off = agg_tou_reo_off * 0.015288;
    let tou_rd_energy_total = tou_rd_fixed + tou_rd_energy_on + tou_rd_energy_off;
    // Instead of a single global max, compute monthly demand charge:
    let demand_rate = 12.21;
    let mut total_demand_charge = 0.0;
    for ((_year, _month), &max_val) in &monthly_max {
        total_demand_charge += max_val * demand_rate;
    }
    let tou_rd_total = tou_rd_energy_total + total_demand_charge;

    // R-30 (Residential Service) total is the sum of monthly totals.
    let r30_total: f64 = r30_breakdown_details.iter().map(|d| d.7).sum();

    // --- Output the final breakdown ---
    println!("Final Bill Totals and Breakdown:\n");

    println!("1. Time-of-Use – Residential Energy Only (TOU-REO):");
    println!("   Fixed Charge: {} days * $0.4603 = ${:.2}", billing_days, tou_reo_fixed);
    println!("   On-Peak Energy: {:.2} kWh @ $0.297868/kWh = ${:.2}", agg_tou_reo_on, tou_reo_energy_on);
    println!("   Off-Peak Energy: {:.2} kWh @ $0.076281/kWh = ${:.2}", agg_tou_reo_off, tou_reo_energy_off);
    println!("   Total TOU-REO Cost: ${:.2}\n", tou_reo_total);

    println!("2. Time-of-Use – Overnight Advantage (TOU-OA):");
    println!("   Fixed Charge: {} days * $0.4603 = ${:.2}", billing_days, tou_oa_fixed);
    println!("   On-Peak Energy: {:.2} kWh @ $0.297868/kWh = ${:.2}", agg_tou_oa_on, tou_oa_energy_on);
    println!("   Off-Peak Energy: {:.2} kWh @ $0.101676/kWh = ${:.2}", agg_tou_oa_off, tou_oa_energy_off);
    println!("   Super Off-Peak Energy: {:.2} kWh @ $0.021859/kWh = ${:.2}", agg_tou_oa_super, tou_oa_energy_super);
    println!("   Total TOU-OA Cost: ${:.2}\n", tou_oa_total);

    println!("3. Time-of-Use – Residential Demand (TOU-RD):");
    println!("   Fixed Charge: {} days * $0.4603 = ${:.2}", billing_days, tou_rd_fixed);
    println!("   On-Peak Energy: {:.2} kWh @ $0.142986/kWh = ${:.2}", agg_tou_reo_on, tou_rd_energy_on);
    println!("   Off-Peak Energy: {:.2} kWh @ $0.015288/kWh = ${:.2}", agg_tou_reo_off, tou_rd_energy_off);
    println!("   Energy Subtotal: ${:.2}", tou_rd_energy_total);
    println!("   Monthly Demand Charges:");
    // Print monthly demand charge breakdown in chronological order.
    let mut monthly_keys: Vec<_> = monthly_max.keys().cloned().collect();
    monthly_keys.sort();
    for (year, month) in monthly_keys {
        let demand = monthly_max.get(&(year, month)).unwrap() * demand_rate;
        println!("     {}-{:02}: Max Usage {:.2} kWh * ${:.2}/kW = ${:.2}", year, month, monthly_max.get(&(year, month)).unwrap(), demand_rate, demand);
    }
    println!("   Total Demand Charge: ${:.2}", total_demand_charge);
    println!("   Total TOU-RD Cost: ${:.2}\n", tou_rd_total);

    println!("4. Residential Service (R-30):");
    println!("   Monthly Breakdown (chronological):");
    // Sort the monthly breakdown details already
    for &(year, month, tier1, tier2, tier3, fixed, energy_cost, monthly_total, total_usage) in &r30_breakdown_details {
        if month >= 6 && month <= 9 {
            println!("     {}-{:02} (Summer):", year, month);
            println!("       Fixed Charge: {} days * $0.4603 = ${:.2}", r30_by_month.get(&(year, month)).unwrap().1, fixed);
            println!("       Tier 1 (first 650 kWh): {:.2} kWh @ $0.086121/kWh = ${:.2}", tier1, tier1 * 0.086121);
            println!("       Tier 2 (next 350 kWh):  {:.2} kWh @ $0.143047/kWh = ${:.2}", tier2, tier2 * 0.143047);
            println!("       Tier 3 (above 1000 kWh): {:.2} kWh @ $0.148051/kWh = ${:.2}", tier3, tier3 * 0.148051);
            println!("       Total Energy Charge: ${:.2}", energy_cost);
            println!("       Monthly Total: ${:.2}\n", monthly_total);
        } else {
            println!("     {}-{:02} (Winter):", year, month);
            println!("       Fixed Charge: {} days * $0.4603 = ${:.2}", r30_by_month.get(&(year, month)).unwrap().1, fixed);
            println!("       Energy Usage: {:.2} kWh @ $0.080602/kWh = ${:.2}", total_usage, total_usage * 0.080602);
            println!("       Monthly Total: ${:.2}\n", monthly_total);
        }
    }
    let overall_r30_total: f64 = r30_breakdown_details.iter().map(|d| d.7).sum();
    println!("   Total R-30 Cost (all months): ${:.2}\n", overall_r30_total);

    println!("Overall Final Totals:");
    println!("   TOU-REO: ${:.2}", tou_reo_total);
    println!("   TOU-OA:  ${:.2}", tou_oa_total);
    println!("   TOU-RD:  ${:.2}", tou_rd_total);
    println!("   R-30:    ${:.2}", overall_r30_total);

    Ok(())
}
