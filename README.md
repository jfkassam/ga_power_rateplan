# Georgia Power Rate Plan Analyzer

This tool helps Georgia Power residential customers find the most cost-effective rate plan based on their actual historical usage. It analyzes your hourly usage data and calculates what your bill would have been under different rate plans (Standard R-30, TOU-REO, TOU-OA, and TOU-RD).

## Features
- **Privacy First**: Your data is processed entirely in your web browser. It is **never** uploaded to any server.
- **Accurate Calculations**: Accounts for seasonal rates, tiers, demand charges, fuel recovery riders, and taxes.
- **Visual Breakdown**: See exactly where your money goes (On-Peak vs Off-Peak, Fixed Charges, etc.).

---

## How to Use (Beginner Guide)

You do not need to install any special software or write any code to use this tool.

### Step 1: Download the Tool
1.  Click the green **<> Code** button at the top of this GitHub page.
2.  Select **Download ZIP**.
3.  Go to your Downloads folder and find the file (usually named `ga_power_rateplan-main.zip`).
4.  Right-click the ZIP file and select **Extract All...** (or similar).
5.  Open the extracted folder.

### Step 2: Open the Application
1.  Navigate into the `web` folder.
2.  Double-click the `index.html` file.
3.  This will open the tool in your default web browser (Chrome, Edge, Firefox, Safari, etc.).

### Step 3: Get Your Usage Data
1.  Log in to your [Georgia Power Account](https://www.georgiapower.com/).
2.  Go to **Billing and Payments** -> **Usage**.
3.  Select **Hourly** view.
4.  Click on **Table** view (instead of Graph).
5.  Click the **Export** button.
6.  Choose **Custom Date Range**.
    *   *Tip: Select the last 12 to 24 months for the most accurate recommendation.*
7.  Click **Export** to download the Excel (`.xlsx`) file.

### Step 4: Analyze Your Plan
1.  Go back to the Rate Analyzer tab in your browser.
2.  Drag and drop your downloaded Excel file into the box, or click to browse and select it.
3.  The tool will instantly calculate the costs for all available plans and highlight the best one for you.

---

## Troubleshooting

*   **"Please upload a valid Excel file"**: Ensure you downloaded the file as an Excel (`.xlsx`) file from Georgia Power, not a CSV.
*   **"Insufficient data"**: The tool needs at least 30 days of data to make a calculation. For best results, use at least 1 full year to account for summer vs. winter rates.
*   **Links not working**: If the "Reference Rate Plans" links don't work, ensure you extracted the ZIP file fully. The PDF files must be in the `web/reference` folder relative to `index.html`.

## Disclaimer
This tool provides an **estimation** based on published rate cards. Actual bills may vary slightly due to rounding, specific municipal taxes, or changes in fuel recovery rates. This project is not affiliated with Georgia Power.
