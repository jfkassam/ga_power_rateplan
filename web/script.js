document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const errorMessage = document.getElementById('error-message');
    const resultsSection = document.getElementById('results-section');

    // Drag & Drop handlers
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFile(files[0]);
        }
    });

    dropZone.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    function handleFile(file) {
        const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');

        if (!isExcel) {
            showError('Please upload a valid Excel file (.xlsx or .xls).');
            return;
        }

        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 }); // Array of arrays
                processData(json);
            } catch (err) {
                showError('Error processing Excel file: ' + err.message);
                console.error(err);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function showError(msg) {
        errorMessage.textContent = msg;
        errorMessage.classList.remove('hidden');
        resultsSection.classList.add('hidden');
    }

    function processData(rows) {
        errorMessage.classList.add('hidden');

        // Find header row
        let headerRowIndex = -1;
        let colMap = { timestamp: -1, kwh: -1 };

        for (let i = 0; i < Math.min(rows.length, 20); i++) {
            const row = rows[i];
            if (!row || row.length === 0) continue;

            // Look for "Hour" and "kWh" (case insensitive)
            const hourIdx = row.findIndex(c => c && c.toString().toLowerCase().includes('hour')); // "Hour" or "Usage Hour"
            const kwhIdx = row.findIndex(c => c && c.toString().toLowerCase().includes('kwh')); // "kWh" or "Usage Amount"

            if (hourIdx !== -1 && kwhIdx !== -1) {
                headerRowIndex = i;
                colMap.timestamp = hourIdx;
                colMap.kwh = kwhIdx;
                break;
            }
        }

        if (headerRowIndex === -1) {
            throw new Error('Could not find "Hour" and "kWh" columns in the first 20 rows.');
        }

        let records = [];

        for (let i = headerRowIndex + 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length <= Math.max(colMap.timestamp, colMap.kwh)) continue;

            const timestampStr = row[colMap.timestamp];
            const kwhVal = row[colMap.kwh];

            if (timestampStr === undefined || timestampStr === null) continue;

            let kwh = parseFloat(kwhVal);
            if (isNaN(kwh)) continue;

            // Filter out zero usage
            if (kwh <= 0.001) continue;

            let dt = null;
            if (typeof timestampStr === 'number') {
                // Excel serial date
                const dateObj = new Date((timestampStr - 25569) * 86400 * 1000);
                dt = new Date(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate(), dateObj.getUTCHours(), dateObj.getUTCMinutes());
            } else {
                dt = parseDate(timestampStr.toString());
            }

            if (dt) {
                records.push({ dt, kwh });
            }
        }

        if (records.length === 0) {
            throw new Error('No valid records found (all zero or invalid).');
        }

        // Sort by date ascending
        records.sort((a, b) => a.dt - b.dt);

        // --- Date Range Logic ---
        // 1. Check total duration
        const startDt = records[0].dt;
        const endDt = records[records.length - 1].dt;
        const durationMs = endDt - startDt;
        const durationDays = durationMs / (1000 * 60 * 60 * 24);

        if (durationDays < 30) {
            showError(`Insufficient data: ${durationDays.toFixed(1)} days found. At least 30 days are required for an accurate recommendation.`);
            return;
        }

        // 2. Truncate to most recent full years if > 1 year
        let usedRecords = records;
        let note = "";

        if (durationDays >= 365) {
            const fullYears = Math.floor(durationDays / 365);
            const targetDays = fullYears * 365;
            const cutoffDate = new Date(endDt.getTime() - (targetDays * 24 * 60 * 60 * 1000));
            usedRecords = records.filter(r => r.dt >= cutoffDate);
            note = `Using most recent ${fullYears} full year(s) of data for accurate seasonal comparison.`;
        } else {
            note = "Less than 1 year of data. Seasonal variations may affect accuracy.";
        }

        // Re-calculate stats for used records
        const effectiveStart = usedRecords[0].dt;
        const effectiveEnd = usedRecords[usedRecords.length - 1].dt;
        const effectiveDuration = (effectiveEnd - effectiveStart) / (1000 * 60 * 60 * 24);

        // Check for gaps
        let gapWarnings = 0;
        for (let i = 0; i < usedRecords.length - 1; i++) {
            const diffMs = usedRecords[i + 1].dt - usedRecords[i].dt;
            const diffMins = diffMs / (1000 * 60);
            if (diffMins > 90) {
                gapWarnings++;
            }
        }

        if (gapWarnings > 50) {
            console.warn(`Detected ${gapWarnings} gaps > 90 mins.`);
        }

        calculateCosts(usedRecords, effectiveDuration, note);
    }

    function parseDate(str) {
        // "2025-02-19 23:00"
        const [datePart, timePart] = str.split(' ');
        if (!datePart || !timePart) return null;
        const [y, m, d] = datePart.split('-').map(Number);
        const [hr, min] = timePart.split(':').map(Number);
        return new Date(y, m - 1, d, hr, min);
    }

    function calculateCosts(records, durationDays, note) {
        // Constants for Riders & Taxes
        const FCR_SUMMER = 0.045876; // ~4.6 cents/kWh (Jun-Sep)
        const FCR_WINTER = 0.042859; // ~4.3 cents/kWh (Oct-May)
        const TAX_RATE = 1.12;       // ~12% for NCCR, ECC, Franchise Fee, Sales Tax

        // Aggregates
        let agg_tou_reo_on = 0;
        let agg_tou_reo_off = 0;
        let agg_tou_oa_on = 0;
        let agg_tou_oa_off = 0;
        let agg_tou_oa_super = 0;

        // Monthly tracking for R-30 and Demand
        const monthlyUsage = {}; // "YYYY-MM" -> { total: 0, days: Set(dayStr), maxDemand: 0, fcr: 0 }

        // FCR Accumulator
        let total_fcr = 0;

        records.forEach(r => {
            const dt = r.dt;
            const kwh = r.kwh;
            const month = dt.getMonth() + 1; // 1-12
            const monthKey = `${dt.getFullYear()}-${String(month).padStart(2, '0')}`;
            const dayKey = `${monthKey}-${String(dt.getDate()).padStart(2, '0')}`;

            // FCR Calculation
            const isSummer = month >= 6 && month <= 9;
            const fcrRate = isSummer ? FCR_SUMMER : FCR_WINTER;
            const fcrCost = kwh * fcrRate;
            total_fcr += fcrCost;

            // Initialize monthly bucket
            if (!monthlyUsage[monthKey]) {
                monthlyUsage[monthKey] = { total: 0, days: new Set(), maxDemand: 0 };
            }
            monthlyUsage[monthKey].total += kwh;
            monthlyUsage[monthKey].days.add(dayKey);
            if (kwh > monthlyUsage[monthKey].maxDemand) {
                monthlyUsage[monthKey].maxDemand = kwh;
            }

            // Classify
            if (isOnPeak(dt)) {
                agg_tou_reo_on += kwh;
            } else {
                agg_tou_reo_off += kwh;
            }

            const oaPeriod = getTouOaPeriod(dt);
            if (oaPeriod === 'on_peak') agg_tou_oa_on += kwh;
            else if (oaPeriod === 'super_off_peak') agg_tou_oa_super += kwh;
            else agg_tou_oa_off += kwh;
        });

        // Billing days calculation
        const allDays = new Set();
        records.forEach(r => {
            const dayKey = `${r.dt.getFullYear()}-${r.dt.getMonth()}-${r.dt.getDate()}`;
            allDays.add(dayKey);
        });
        const billingDays = allDays.size;

        // --- Costs (Base + FCR) * Tax ---

        // 1. TOU-REO
        const tou_reo_fixed = 0.4603 * billingDays;
        const tou_reo_energy = (agg_tou_reo_on * 0.297868) + (agg_tou_reo_off * 0.076281);
        const tou_reo_total = (tou_reo_fixed + tou_reo_energy + total_fcr) * TAX_RATE;

        // 2. TOU-OA
        const tou_oa_fixed = 0.4603 * billingDays;
        const tou_oa_energy = (agg_tou_oa_on * 0.297868) + (agg_tou_oa_off * 0.101676) + (agg_tou_oa_super * 0.021859);
        const tou_oa_total = (tou_oa_fixed + tou_oa_energy + total_fcr) * TAX_RATE;

        // 3. TOU-RD
        const tou_rd_fixed = 0.4603 * billingDays;
        const tou_rd_energy = (agg_tou_reo_on * 0.142986) + (agg_tou_reo_off * 0.015288);
        let total_demand_charge = 0;
        Object.values(monthlyUsage).forEach(m => {
            total_demand_charge += m.maxDemand * 12.21;
        });
        const tou_rd_total = (tou_rd_fixed + tou_rd_energy + total_demand_charge + total_fcr) * TAX_RATE;

        // 4. R-30
        let r30_base_total = 0;
        Object.keys(monthlyUsage).forEach(key => {
            const [year, month] = key.split('-').map(Number); // month is 1-based
            const usage = monthlyUsage[key].total;
            const days = monthlyUsage[key].days.size;

            const fixed = 0.4603 * days;
            let energyCost = 0;

            if (month >= 6 && month <= 9) { // Summer
                const tier1 = Math.min(usage, 650);
                const tier2 = usage > 650 ? Math.min(usage - 650, 350) : 0;
                const tier3 = usage > 1000 ? usage - 1000 : 0;
                energyCost = (tier1 * 0.086121) + (tier2 * 0.143047) + (tier3 * 0.148051);
            } else { // Winter
                energyCost = usage * 0.080602;
            }
            r30_base_total += fixed + energyCost;
        });
        const r30_total = (r30_base_total + total_fcr) * TAX_RATE;

        // Display
        displayResults({
            tou_reo: { total: tou_reo_total, breakdown: { fixed: tou_reo_fixed, energy: tou_reo_energy, fcr: total_fcr, tax: tou_reo_total - (tou_reo_fixed + tou_reo_energy + total_fcr) } },
            tou_oa: { total: tou_oa_total, breakdown: { fixed: tou_oa_fixed, energy: tou_oa_energy, fcr: total_fcr, tax: tou_oa_total - (tou_oa_fixed + tou_oa_energy + total_fcr) } },
            tou_rd: { total: tou_rd_total, breakdown: { fixed: tou_rd_fixed, energy: tou_rd_energy, demand: total_demand_charge, fcr: total_fcr, tax: tou_rd_total - (tou_rd_fixed + tou_rd_energy + total_demand_charge + total_fcr) } },
            r30: { total: r30_total, breakdown: { fixed: 0.4603 * billingDays, energy: r30_base_total - (0.4603 * billingDays), fcr: total_fcr, tax: r30_total - (r30_base_total + total_fcr) } },
            stats: {
                start: records[0].dt,
                end: records[records.length - 1].dt,
                duration: durationDays,
                totalUsage: records.reduce((sum, r) => sum + r.kwh, 0),
                note: note
            }
        });
    }

    function isOnPeak(dt) {
        // Mon(1)..Fri(5) in JS? No, Sun=0, Mon=1...Sat=6.
        // Rust: Mon=0..Fri=4.
        // So JS: day >= 1 && day <= 5.
        const month = dt.getMonth() + 1; // 1-12
        const hour = dt.getHours();
        const day = dt.getDay(); // 0=Sun, 1=Mon...

        const isWeekday = day >= 1 && day <= 5;
        const isSummer = month >= 6 && month <= 9;
        const isPeakHour = hour >= 14 && hour < 19; // 14:00 - 18:59

        return isWeekday && isSummer && isPeakHour;
    }

    function getTouOaPeriod(dt) {
        if (isOnPeak(dt)) return 'on_peak';
        const hour = dt.getHours();
        if (hour >= 23 || hour < 7) return 'super_off_peak';
        return 'off_peak';
    }

    function displayResults(results) {
        resultsSection.classList.remove('hidden');

        const plans = [
            { id: 'tou-reo', name: 'TOU-REO', cost: results.tou_reo.total, breakdown: results.tou_reo.breakdown },
            { id: 'tou-oa', name: 'TOU-OA', cost: results.tou_oa.total, breakdown: results.tou_oa.breakdown },
            { id: 'tou-rd', name: 'TOU-RD', cost: results.tou_rd.total, breakdown: results.tou_rd.breakdown },
            { id: 'r30', name: 'R-30', cost: results.r30.total, breakdown: results.r30.breakdown }
        ];

        // Sort by cost
        plans.sort((a, b) => a.cost - b.cost);
        const best = plans[0];

        // Find R-30 cost for comparison
        const r30Plan = plans.find(p => p.id === 'r30');
        const r30Cost = r30Plan ? r30Plan.cost : 0;

        // Update UI
        document.getElementById('best-plan-name').textContent = best.name;

        const savings = r30Cost - best.cost;
        const savingsElement = document.getElementById('best-plan-savings');

        if (best.id === 'r30') {
            savingsElement.textContent = "The Standard Residential (R-30) plan is your best option.";
            savingsElement.style.color = "var(--text-primary)";
        } else if (savings > 0) {
            savingsElement.textContent = `Save $${savings.toFixed(2)} compared to R-30 (Standard)`;
            savingsElement.style.color = "var(--success-color)";
        } else {
            savingsElement.textContent = `Save $${savings.toFixed(2)} compared to R-30 (Standard)`;
            savingsElement.style.color = "var(--success-color)";
        }

        plans.forEach(p => {
            const card = document.getElementById(`card-${p.id}`);
            document.getElementById(`price-${p.id}`).textContent = `$${p.cost.toFixed(2)}`;

            // Highlight best
            if (p.id === best.id) {
                card.style.borderColor = 'var(--success-color)';
                card.style.backgroundColor = 'rgba(34, 197, 94, 0.05)';
            } else {
                card.style.borderColor = 'var(--border-color)';
                card.style.backgroundColor = 'var(--card-bg)';
            }

            // Add Breakdown
            let breakdownHtml = `<div class="cost-breakdown">`;
            breakdownHtml += `<div class="breakdown-row"><span>Base Energy:</span><span>$${p.breakdown.energy.toFixed(2)}</span></div>`;
            if (p.breakdown.demand) {
                breakdownHtml += `<div class="breakdown-row"><span>Demand:</span><span>$${p.breakdown.demand.toFixed(2)}</span></div>`;
            }
            breakdownHtml += `<div class="breakdown-row"><span>Fuel Recovery:</span><span>$${p.breakdown.fcr.toFixed(2)}</span></div>`;
            breakdownHtml += `<div class="breakdown-row"><span>Fixed:</span><span>$${p.breakdown.fixed.toFixed(2)}</span></div>`;
            breakdownHtml += `<div class="breakdown-row tax-row"><span>Taxes & Fees (12%):</span><span>$${p.breakdown.tax.toFixed(2)}</span></div>`;
            breakdownHtml += `</div>`;

            // Check if breakdown already exists to avoid duplicates
            let existingBreakdown = card.querySelector('.cost-breakdown');
            if (existingBreakdown) {
                existingBreakdown.innerHTML = breakdownHtml; // Update content? No, innerHTML includes the wrapper.
                existingBreakdown.outerHTML = breakdownHtml;
            } else {
                card.insertAdjacentHTML('beforeend', breakdownHtml);
            }
        });

        // Stats
        document.getElementById('data-range').textContent = `${results.stats.start.toLocaleDateString()} - ${results.stats.end.toLocaleDateString()}`;
        document.getElementById('data-duration').textContent = results.stats.duration.toFixed(0);
        document.getElementById('total-usage').textContent = results.stats.totalUsage.toFixed(2);

        // Add note if present
        let noteEl = document.getElementById('data-note');
        if (!noteEl) {
            noteEl = document.createElement('p');
            noteEl.id = 'data-note';
            noteEl.style.marginTop = '0.5rem';
            noteEl.style.fontStyle = 'italic';
            document.querySelector('.data-stats').appendChild(noteEl);
        }
        noteEl.textContent = results.stats.note;

        // Add rates effective note
        let ratesNote = document.getElementById('rates-note');
        if (!ratesNote) {
            ratesNote = document.createElement('p');
            ratesNote.id = 'rates-note';
            ratesNote.className = 'subtitle';
            ratesNote.style.fontSize = '0.8rem';
            ratesNote.style.marginTop = '0.5rem';
            document.querySelector('header').appendChild(ratesNote);
        }
        ratesNote.innerHTML = 'Rates effective Jan 2025.<br>Includes estimated Fuel Cost Recovery (~4.3-4.6¢/kWh) and Taxes/Fees (~12%) to match actual bills.';
    }
});
