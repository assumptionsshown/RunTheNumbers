using System.Text.Json;
using System.Text.Json.Serialization;

namespace RunTheNumbers.Sim;

/// <summary>Episode 2 - what 1% a year actually costs.</summary>
public static class Ep02
{
    // 0.03% is roughly the cheapest broad index fund available; 1% is the number
    // the episode is named after; 2% is not unusual once an adviser fee sits on
    // top of a fund fee.
    private static readonly double[] Fees = [0.0000, 0.0003, 0.0025, 0.0050, 0.0100, 0.0200];
    private static readonly int[] Horizons = [10, 20, 30, 40];

    public static void Run(string snapshotDir, string outputPath)
    {
        var series = ShillerSeries.Load(Path.Combine(snapshotDir, "shiller-monthly.csv"));
        var manifest = JsonSerializer.Deserialize<JsonElement>(
            File.ReadAllText(Path.Combine(snapshotDir, "manifest.json")));

        Console.WriteLine($"loaded {series.Count} months: {series.Months[0].Date} .. {series.Months[^1].Date}");

        var sim = new FeeDrag(series);

        var grid = (from f in Fees from h in Horizons select sim.Run(f, h)).ToArray();
        var onepercentByYear = sim.ByYear(0.01, 40);

        // Yearly resolution for every fee level, so the compounding can be drawn as
        // a curve rather than four straight segments between the horizons above.
        var feeCurves = Fees.Where(f => f > 0)
            .Select(f => new { fee = f, points = sim.ByYear(f, 40) })
            .ToArray();
        var (exampleFree, exampleFee, exampleLost) = sim.Example(0.01, 30, 10_000);

        // The other side of the question. A fee is only a pure loss to someone who
        // would have held anyway. Price the mistake it might prevent, over a grid
        // rather than at one flattering setting.
        var panic = new PanicSell(series);
        double[] thresholds = [0.20, 0.30, 0.40];
        ReentryRule[] rules =
        [
            new ReentryRule.AfterMonths(6),
            new ReentryRule.AfterMonths(12),
            new ReentryRule.AfterMonths(24),
            new ReentryRule.AfterRecovery(0.20),
        ];
        var panicGrid = (from t in thresholds from r in rules select panic.Run(t, r, 30, 1)).ToArray();

        // The number the fee debate never puts a figure on: how many panics does
        // an adviser have to prevent before the fee has paid for itself? Panics do
        // not add up linearly, so this is simulated rather than estimated.
        var breakEvens = (
            from f in Fees.Where(f => f > 0)
            from t in thresholds
            from r in rules
            select panic.FindBreakEven(sim, f, t, r, 30, 8)
        ).ToArray();

        // The comparison the episode exists for.
        var fee1pct30y = grid.First(x => x.AnnualFee == 0.01 && x.HorizonYears == 30);
        var panicCosts = panicGrid.Select(p => p.MedianCost).Where(double.IsFinite).ToList();

        var result = new
        {
            meta = new
            {
                episode = "ep02-fees",
                generatedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
                snapshot = manifest,
                firstMonth = series.Months[0].Date,
                lastMonth = series.Months[^1].Date,
                months = series.Count,
                assumptions = new[]
                {
                    "Real (inflation-adjusted) total return, dividends reinvested.",
                    "The fee is deducted monthly at one twelfth of the annual rate, which is close to how a fund actually accrues its expense ratio.",
                    "The fee is charged on the whole balance, not on the gain.",
                    "The fee rate is held constant for the entire period. This flatters the high-fee case, since real fee schedules have generally fallen.",
                    "No taxes, no transaction costs, no bid-ask spread.",
                    "US large-cap index only (S&P Composite).",
                    "Buy and hold from a single lump sum. No contributions during the period.",
                    "Panic-sale scenario: one sale per lifetime, into cash that holds its real value. Both choices are generous to the seller, so they understate rather than overstate what the mistake costs.",
                },
            },

            feeGrid = grid,
            onePercentByYear = onepercentByYear,
            feeCurves,
            panicGrid,
            breakEvens,
            feeVersusPanic = new
            {
                feeCostOfBalance30y = fee1pct30y.ShareOfFinalLost,
                feeCostOfGain30y = fee1pct30y.ShareOfGainLost,
                onePanicCostLow = panicCosts.Count > 0 ? panicCosts.Min() : double.NaN,
                onePanicCostHigh = panicCosts.Count > 0 ? panicCosts.Max() : double.NaN,
                note = "Compare like with like: both are shares of the final balance over 30 years.",
            },
            example = new
            {
                annualFee = 0.01,
                horizonYears = 30,
                startingAmount = 10_000,
                withoutFee = exampleFree,
                withFee = exampleFee,
                lostToFee = exampleLost,
                shareLost = exampleLost / exampleFree,
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

        Report(grid, onepercentByYear, exampleFree, exampleFee, exampleLost);
        ReportPanic(panicGrid, fee1pct30y);
        ReportBreakEven(breakEvens);
    }

    private static void ReportPanic(IReadOnlyList<PanicResult> panicGrid, FeeResult fee1pct30y)
    {
        Console.WriteLine();
        Console.WriteLine("What ONE panic sale costs, 30-year hold, across the whole parameter grid");
        Console.WriteLine("  sells at   gets back in                        median cost   worst");
        foreach (var p in panicGrid)
        {
            Console.WriteLine(
                $"  {p.DropThreshold,7:P0}   {p.Reentry,-34}  {p.MedianCost,11:P1}   {p.WorstCost,6:P1} ({p.WorstStart})");
        }

        var finite = panicGrid.Select(p => p.MedianCost).Where(double.IsFinite).ToList();
        Console.WriteLine();
        Console.WriteLine("Both as a share of the 30-year balance:");
        Console.WriteLine($"  1% a year, every year, for 30 years   {fee1pct30y.ShareOfFinalLost,7:P1}");
        Console.WriteLine($"  one panic sale, across the grid       {finite.Min(),7:P1} to {finite.Max():P1}");
    }

    private static void ReportBreakEven(IReadOnlyList<BreakEven> breakEvens)
    {
        Console.WriteLine();
        Console.WriteLine("HOW MANY PANICS MUST AN ADVISER PREVENT FOR THE FEE TO PAY FOR ITSELF?");
        Console.WriteLine("30-year hold, median across every start month since 1871.");
        Console.WriteLine();
        Console.WriteLine("  fee     sells at   gets back in                     needs   the market only offers");

        foreach (var b in breakEvens)
        {
            var answer = b.PanicsToBreakEven is { } n ? $"{n:F1}" : "never";
            Console.WriteLine(
                $"  {b.AnnualFee,5:P2}   {b.DropThreshold,7:P0}   {b.Reentry,-34} {answer,7}   {b.MeanPanicsAvailable,6:F1}" +
                (b.MonotonicInPanicCount ? "" : "   (not monotonic)"));
        }

        Console.WriteLine();
        Console.WriteLine("Per fee level, across all 12 settings:");
        foreach (var fee in breakEvens.Select(b => b.AnnualFee).Distinct())
        {
            var forFee = breakEvens.Where(b => b.AnnualFee == fee).ToList();
            var solved = forFee.Where(b => b.PanicsToBreakEven.HasValue)
                .Select(b => b.PanicsToBreakEven!.Value).ToList();
            int never = forFee.Count - solved.Count;

            var range = solved.Count > 0 ? $"{solved.Min():F1} to {solved.Max():F1}" : "no setting";
            Console.WriteLine(
                $"  {fee,5:P2}  breaks even at {range,-14} panics prevented" +
                (never > 0
                    ? $"   |  {never} of {forFee.Count} settings: panicking EVERY time still beats the fee"
                    : ""));
        }
    }

    private static void Report(
        IReadOnlyList<FeeResult> grid,
        IReadOnlyList<FeeYearPoint> byYear,
        double exampleFree, double exampleFee, double exampleLost)
    {
        Console.WriteLine();
        Console.WriteLine("Real wealth per $1, buy and hold, median across all start months");
        Console.WriteLine("  fee       10y      20y      30y      40y");
        foreach (var fee in Fees)
        {
            Console.Write($"  {fee,6:P2}");
            foreach (var h in Horizons)
            {
                var r = grid.First(x => x.AnnualFee == fee && x.HorizonYears == h);
                Console.Write($"  {r.Wealth.Median,7:F3}");
            }
            Console.WriteLine();
        }

        Console.WriteLine();
        Console.WriteLine("Share of the GAIN consumed by the fee");
        Console.WriteLine("  fee       10y      20y      30y      40y");
        foreach (var fee in Fees.Where(f => f > 0))
        {
            Console.Write($"  {fee,6:P2}");
            foreach (var h in Horizons)
            {
                var r = grid.First(x => x.AnnualFee == fee && x.HorizonYears == h);
                Console.Write($"  {r.ShareOfGainLost,7:P1}");
            }
            Console.WriteLine();
        }

        Console.WriteLine();
        Console.WriteLine("1% a year, share of gain consumed, by holding period");
        foreach (var p in byYear.Where(p => p.HorizonYears % 5 == 0))
        {
            Console.WriteLine($"  {p.HorizonYears,2}y   {p.ShareOfGainLost,7:P1} of the gain   {p.ShareOfFinalLost,7:P1} of the balance");
        }

        Console.WriteLine();
        Console.WriteLine($"$10,000 held 30 years at 1%: ${exampleFee:N0} instead of ${exampleFree:N0}, ${exampleLost:N0} to the fee ({exampleLost / exampleFree:P1})");
    }
}
