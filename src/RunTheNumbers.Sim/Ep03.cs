using System.Text.Json;
using System.Text.Json.Serialization;

namespace RunTheNumbers.Sim;

/// <summary>Episode 3 - what if you only ever bought at the market top.</summary>
public static class Ep03
{
    public static void Run(string snapshotDir, string outputPath)
    {
        var series = ShillerSeries.Load(Path.Combine(snapshotDir, "shiller-monthly.csv"));
        var manifest = JsonSerializer.Deserialize<JsonElement>(
            File.ReadAllText(Path.Combine(snapshotDir, "manifest.json")));

        Console.WriteLine($"loaded {series.Count} months: {series.Months[0].Date} .. {series.Months[^1].Date}");

        var sim = new AllTimeHighs(series);

        HighBasis[] bases =
        [
            HighBasis.NominalPrice, HighBasis.RealPrice,
            HighBasis.NominalTotalReturn, HighBasis.RealTotalReturn,
        ];

        // Two start years on purpose. 1871 is the whole sample; 1960 is the window
        // the widely quoted version of this claim uses, and quoting a number over
        // a different window than its source is how replications go wrong.
        var frequency = (from b in bases from y in new[] { 1871, 1960 } select sim.Frequency(b, y)).ToArray();

        int[] horizons = [12, 36, 60, 120];
        var forward = (from h in horizons select sim.Forward(HighBasis.NominalPrice, false, h, 1871)).ToArray();

        // The reconciliation block. The number in circulation is nominal, measured
        // from 1960, and its definition of "high" is not stated. All three choices
        // move it, so all three are shown rather than the one that matches.
        var reconciliation = new[]
        {
            sim.Forward(HighBasis.NominalPrice, true, 12, 1960),
            sim.Forward(HighBasis.NominalTotalReturn, true, 12, 1960),
            sim.Forward(HighBasis.NominalPrice, false, 12, 1960),
            sim.Forward(HighBasis.NominalTotalReturn, false, 12, 1960),
        };

        var saver40 = sim.SaverTiming(40);
        var saver20 = sim.SaverTiming(20);

        double[] dips = [0.10, 0.20, 0.30];
        var waiting = (from d in dips select sim.WaitForDip(d, 10)).ToArray();

        var byCape = sim.AfterHighByCape(HighBasis.NominalPrice, 60);

        var peak = saver40.First(s => s.Strategy == "peak");
        var january = saver40.First(s => s.Strategy == "january");
        var cash = saver40.First(s => s.Strategy == "cash");

        var result = new
        {
            meta = new
            {
                episode = "ep03-buying-at-the-top",
                generatedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
                snapshot = manifest,
                firstMonth = series.Months[0].Date,
                lastMonth = series.Months[^1].Date,
                months = series.Count,
                assumptions = new[]
                {
                    "Real (inflation-adjusted) total return, dividends reinvested, unless a line is explicitly labelled nominal.",
                    "Shiller's data is monthly averages, not daily closes, so 'the top' means the worst month of the year, not the worst day.",
                    "A new high means a strict new high on the stated index. Four definitions are reported because the choice changes the frequency several times over.",
                    "Idle cash holds its real value (0% real). Deliberately the generous assumption for waiting.",
                    "No taxes, no transaction costs, no fund fees.",
                    "US large-cap index only (S&P Composite).",
                    "Start months overlap, so counts are not independent trials.",
                },
            },

            // 1. How often is the market at an all-time high at all?
            frequency,

            // 2. What happens after one, against what happens after any month.
            forward,
            reconciliation,
            afterHighByCape = byCape,

            // 3. The saver with impossible bad luck.
            saverTiming40 = saver40,
            saverTiming20 = saver20,
            headline = new
            {
                years = 40,
                worstTimingWealth = peak.MedianWealth,
                immediateWealth = january.MedianWealth,
                cashWealth = cash.MedianWealth,
                worstTimingVersusImmediate = peak.MedianVsImmediate,
                worstTimingVersusCash = cash.MedianWealth > 0 ? peak.MedianWealth / cash.MedianWealth : double.NaN,
            },

            // 4. The alternative people actually pick.
            waiting,
        };

        var json = JsonSerializer.Serialize(result, new JsonSerializerOptions
        {
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        });

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        File.WriteAllText(outputPath, json);
        Console.WriteLine($"wrote {outputPath}");

        Report(frequency, forward, reconciliation, saver40, saver20, waiting, byCape);
    }

    private static void Report(
        IReadOnlyList<HighFrequency> frequency,
        IReadOnlyList<ForwardReturns> forward,
        IReadOnlyList<ForwardReturns> reconciliation,
        IReadOnlyList<TimingResult> saver40,
        IReadOnlyList<TimingResult> saver20,
        IReadOnlyList<DipWaitResult> waiting,
        IReadOnlyList<object> byCape)
    {
        Console.WriteLine();
        Console.WriteLine("HOW OFTEN IS THE MARKET AT AN ALL-TIME HIGH?");
        Console.WriteLine("  index                 from       months   highs    share");
        foreach (var f in frequency)
            Console.WriteLine($"  {f.Basis,-20}  {f.From}    {f.Months,5}   {f.Highs,5}   {f.Share,7:P1}");

        Console.WriteLine();
        Console.WriteLine("REAL TOTAL RETURN AFTER A NOMINAL-PRICE HIGH, vs after any month");
        Console.WriteLine("  horizon      n     after high (mean / median / positive)      any month (mean / median / positive)");
        foreach (var r in forward)
        {
            Console.WriteLine(
                $"  {r.HorizonMonths / 12,2}y    {r.AfterHighCount,5}     {r.AfterHighMean,7:P1} {r.AfterHighMedian,8:P1} {r.AfterHighPositive,9:P1}          " +
                $"{r.AllStartsMean,7:P1} {r.AllStartsMedian,8:P1} {r.AllStartsPositive,9:P1}");
        }

        Console.WriteLine();
        Console.WriteLine("RECONCILING THE QUOTED NUMBER (12 months, from 1960)");
        Console.WriteLine("  high defined on        measured on              n     mean    positive");
        foreach (var r in reconciliation)
        {
            Console.WriteLine(
                $"  {r.HighBasis,-20}   {r.MeasuredOn,-20}  {r.AfterHighCount,5}   {r.AfterHighMean,6:P1}   {r.AfterHighPositive,7:P1}");
        }

        foreach (var (label, saver) in new[] { ("40", saver40), ("20", saver20) })
        {
            Console.WriteLine();
            Console.WriteLine($"CONTRIBUTING ONE UNIT A YEAR FOR {label} YEARS, median real wealth at the end");
            Console.WriteLine("  strategy    windows    median     mean      5th pct    vs investing in January");
            foreach (var s in saver)
            {
                Console.WriteLine(
                    $"  {s.Strategy,-10}  {s.Windows,5}    {s.MedianWealth,8:F2}  {s.MeanWealth,8:F2}   {s.P5Wealth,8:F2}   {s.MedianVsImmediate,10:P1}");
            }
        }

        Console.WriteLine();
        Console.WriteLine("WAITING FOR A DIP BEFORE INVESTING, 10-year horizon");
        Console.WriteLine("  waits for   starts   waiting wins   median cost   dip never came   median months waited");
        foreach (var w in waiting)
        {
            Console.WriteLine(
                $"  {w.DipThreshold,8:P0}   {w.Starts,5}   {w.WaitingWinRate,11:P1}   {w.MedianCostOfWaiting,11:P1}   {w.NeverArrivedShare,13:P1}   {w.MedianMonthsWaited,18:F0}");
        }

        Console.WriteLine();
        Console.WriteLine("FIVE-YEAR REAL RETURN AFTER A HIGH, BY STARTING VALUATION");
        foreach (var b in byCape) Console.WriteLine($"  {JsonSerializer.Serialize(b)}");
    }
}
