using System.Text.Json;
using System.Text.Json.Serialization;
using RunTheNumbers.Sim;

// Episode simulations.
//
//   dotnet run --project src/RunTheNumbers.Sim -- <snapshotDir> <outputJson> [--episode ep02|ep03]
//
// Episode 1 is the default and stays inline below. Later episodes live in their
// own files, so adding one cannot disturb a published result.

var snapshotDir = args.Length > 0
    ? args[0]
    : Path.Combine("data", "snapshots", "shiller-2026-07-26");
var outputPath = args.Length > 1
    ? args[1]
    : Path.Combine("episodes", "ep01-lumpsum-vs-dca", "results.json");

var episodeFlag = Array.IndexOf(args, "--episode");
var episode = episodeFlag >= 0 && episodeFlag + 1 < args.Length ? args[episodeFlag + 1] : "ep01";

if (episode == "ep02")
{
    Ep02.Run(snapshotDir, outputPath);
    return;
}

if (episode == "ep03")
{
    Ep03.Run(snapshotDir, outputPath);
    return;
}

if (episode == "ep04")
{
    var fredFlag = Array.IndexOf(args, "--fred");
    var fredDir = fredFlag >= 0 && fredFlag + 1 < args.Length
        ? args[fredFlag + 1]
        : Path.Combine("data", "snapshots", "fred-housing-2026-07-31");
    var housingFlag = Array.IndexOf(args, "--housing");
    var housingDir = housingFlag >= 0 && housingFlag + 1 < args.Length
        ? args[housingFlag + 1]
        : Path.Combine("data", "snapshots", "housing-metro-crosswalk-2026-08-01");
    Ep04.Run(snapshotDir, fredDir, housingDir, outputPath);
    return;
}

var series = ShillerSeries.Load(Path.Combine(snapshotDir, "shiller-monthly.csv"));
var manifest = JsonSerializer.Deserialize<JsonElement>(
    File.ReadAllText(Path.Combine(snapshotDir, "manifest.json")));

Console.WriteLine($"loaded {series.Count} months: {series.Months[0].Date} .. {series.Months[^1].Date}");

int[] windows = [3, 6, 12, 24];
int[] horizons = [1, 5, 10];

var baseCase = new LumpSumVsDca(series, CashPolicy.HoldsRealValue);
var harsh = new LumpSumVsDca(series, CashPolicy.ZeroNominal);

// The headline claim of this episode is that the winner is settled during the
// deployment window. Verify it numerically before reporting anything else.
var drift = baseCase.MaxRatioDriftAcrossHorizons(12, horizons);
Console.WriteLine($"max DCA/LS ratio drift across horizons: {drift:E3}");
if (drift > 1e-9)
    throw new InvalidOperationException($"ratio is not horizon-independent (drift {drift})");

// DCA's whole claim is a better worst case. Track the 5th percentile of both
// strategies as the holding period lengthens to find where that claim stops
// being true.
int[] tailHorizons = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20];
var tailCrossover = tailHorizons.Select(h =>
{
    var r = baseCase.Horizon(12, h);
    return new
    {
        horizonYears = h,
        starts = r.Starts,
        lumpSumP5 = r.LumpSum.P5,
        dcaP5 = r.Dca.P5,
        dcaTailAdvantage = r.Dca.P5 - r.LumpSum.P5,
        lumpSumP1 = r.LumpSum.P1,
        dcaP1 = r.Dca.P1,
        lumpSumMedian = r.LumpSum.Median,
        dcaMedian = r.Dca.Median,
        dcaMedianCost = r.Dca.Median / r.LumpSum.Median - 1.0,
        // Start months overlap heavily, so `starts` wildly overstates how much
        // independent evidence there is. At a 20-year hold, 155 years of history
        // contains only a handful of genuinely separate periods, and a tail
        // percentile computed from that cannot support a confident claim.
        independentPeriods = (series.Count / 12) / (h + 1),
    };
}).ToArray();

var result = new
{
    meta = new
    {
        episode = "ep01-lumpsum-vs-dca",
        generatedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
        snapshot = manifest,
        firstMonth = series.Months[0].Date,
        lastMonth = series.Months[^1].Date,
        months = series.Count,
        // Canonical wording. The episode README is the source of truth for these
        // strings; keep them identical here, on the slides and in the description.
        // An assumption phrased two ways in two places reads as one nobody checked.
        assumptions = new[]
        {
            "Real (inflation-adjusted) total return, dividends reinvested.",
            "Base case: idle cash holds its real value (0% real). Deliberately the generous assumption for DCA.",
            "Sensitivity: idle cash earns 0% nominal, so it erodes with inflation.",
            "No taxes, no transaction costs, no fund fees.",
            "US large-cap index only (S&P Composite).",
            "The holding period is measured from the month of the final purchase.",
        },
    },

    // Win rates and gaps carry no horizon: once fully deployed, both portfolios
    // hold the same asset.
    horizonIndependence = new { maxRatioDrift = drift, checkedWindowMonths = 12, horizons },

    tailCrossover,

    baseCase = new
    {
        cashPolicy = "idle cash holds its real value (0% real)",
        windows = windows.Select(baseCase.Window).ToArray(),
        gapHistogram12mo = baseCase.GapHistogram(12, 0.01),
        gapSeries12mo = baseCase.GapSeries(12) is var s
            ? new { firstDate = s.FirstDate, gaps = s.Gaps.Select(g => Math.Round(g, 5)).ToArray() }
            : null,
        // Two start dates that tell opposite stories, for the animated section.
        pathways = new[]
        {
            baseCase.Path("1998-04", 12, 10,
                "The market kept climbing while the drip was still buying, so it bought higher every month. Then 2000 hit both."),
            baseCase.Path("1931-08", 12, 10,
                "The market collapsed while the drip was still buying, so it bought lower every month. This is the case DCA is sold on."),
        },
        capeDeciles = baseCase.ByCapeDecile(12),
        worstLumpSumStarts = baseCase.WorstLumpSumStarts(12, 10, 8),
        horizons = (from w in windows from h in horizons select baseCase.Horizon(w, h)).ToArray(),
    },

    sensitivityZeroNominalCash = new
    {
        cashPolicy = "idle cash earns 0% nominal (erodes with inflation)",
        windows = windows.Select(harsh.Window).ToArray(),
    },
};

var json = JsonSerializer.Serialize(result, new JsonSerializerOptions
{
    WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.Never,
});

Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
File.WriteAllText(outputPath, json);
Console.WriteLine($"wrote {outputPath}");

// --- Console summary so the numbers are visible without opening the JSON -----
Console.WriteLine();
Console.WriteLine("Base case - cash holds real value");
Console.WriteLine("  window   starts   lump sum wins   median gap (DCA vs LS)   best for DCA");
foreach (var w in windows.Select(baseCase.Window))
{
    Console.WriteLine(
        $"  {w.Months,2}mo    {w.Starts,5}    {w.LumpSumWinRate,10:P1}   {w.GapMedian,20:P2}   {w.GapMax,8:P1} ({w.GapMaxDate})");
}

Console.WriteLine();
Console.WriteLine("Sensitivity - cash earns 0% nominal");
foreach (var w in windows.Select(harsh.Window))
{
    Console.WriteLine($"  {w.Months,2}mo    lump sum wins {w.LumpSumWinRate,7:P1}   median gap {w.GapMedian,8:P2}");
}

Console.WriteLine();
Console.WriteLine("Final real wealth per $1, 12-month DCA vs lump sum");
Console.WriteLine("  horizon    LS median   DCA median    LS 5th pct   DCA 5th pct");
foreach (var h in horizons)
{
    var r = baseCase.Horizon(12, h);
    Console.WriteLine(
        $"  {h,2}y        {r.LumpSum.Median,9:F3}   {r.Dca.Median,9:F3}    {r.LumpSum.P5,10:F3}   {r.Dca.P5,10:F3}");
}

Console.WriteLine();
Console.WriteLine("Does DCA's better worst case survive a longer hold? (12-month window)");
Console.WriteLine("  horizon   LS 5th pct   DCA 5th pct   DCA advantage   DCA median cost   indep. periods");
foreach (var t in tailCrossover)
{
    Console.WriteLine(
        $"  {t.horizonYears,2}y       {t.lumpSumP5,10:F3}   {t.dcaP5,11:F3}   {t.dcaTailAdvantage,13:+0.000;-0.000}   {t.dcaMedianCost,15:P2}   {t.independentPeriods,14}");
}

Console.WriteLine();
Console.WriteLine("DCA win rate by starting CAPE decile (12-month window)");
foreach (var b in baseCase.ByCapeDecile(12))
{
    Console.WriteLine(
        $"  decile {b.Decile,2}  CAPE {b.CapeLow,6:F1}-{b.CapeHigh,6:F1}   n={b.Starts,4}   DCA wins {b.DcaWinRate,7:P1}   median gap {b.GapMedian,7:P2}");
}
