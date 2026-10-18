using System.Text.Json;
using System.Text.Json.Serialization;

namespace RunTheNumbers.Sim;

/// <summary>Episode 6 - the 4% rule and the year you happened to retire in.</summary>
public static class Ep06
{
    private const double Base = 0.60;   // stock share of the base-case portfolio
    private const int Horizon = 30;

    public static void Run(string snapshotDir, string outputPath)
    {
        var series = ShillerSeries.Load(Path.Combine(snapshotDir, "shiller-monthly.csv"));
        var manifest = JsonSerializer.Deserialize<JsonElement>(
            File.ReadAllText(Path.Combine(snapshotDir, "manifest.json")));

        var sim = new Retirement(series);
        Console.WriteLine($"annual rows {sim.FirstYear}..{sim.LastYear}");

        double[] rates = [0.03, 0.035, 0.04, 0.045, 0.05, 0.055, 0.06];
        double[] mixes = [0.0, 0.25, 0.5, 0.6, 0.75, 1.0];
        int[] horizons = [20, 25, 30, 40];

        var byRate = rates.Select(r => sim.ByRate(r, Horizon, Base)).ToArray();
        var byMix = mixes.Select(m => sim.ByMix(m, 0.04, Horizon)).ToArray();
        var byHorizon = horizons.Select(h => sim.ByRate(0.04, h, Base)).ToArray();
        var timeline = sim.Timeline(0.04, Horizon, Base);
        var worst = sim.WorstCohorts(0.04, Horizon, Base, 8);
        var four = byRate.First(r => Math.Abs(r.Rate - 0.04) < 1e-9);

        // The rate at which nobody ran out. "Safe" in "safe withdrawal rate" is
        // set by the single worst cohort, not by the typical one, and that is the
        // whole reason the median retiree dies rich.
        double safe = sim.SafeRate(Horizon, Base);

        // Sequence risk, measured rather than asserted: the worst cohort's own
        // returns played backwards. Same years, same average, only the order
        // changes.
        var worstYear = worst[0].StartYear;
        var (forward, reversed) = sim.SequenceTest(worstYear, 0.04, Horizon, Base);

        var result = new
        {
            meta = new
            {
                episode = "ep06-four-percent-rule",
                generatedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
                snapshot = manifest,
                firstYear = sim.FirstYear,
                lastYear = sim.LastYear,
                assumptions = new[]
                {
                    "Real (inflation-adjusted) returns throughout. A withdrawal that rises with inflation is a constant real withdrawal, so spending is held constant in real terms by construction.",
                    "Base case is 60% stocks / 40% ten-year Treasuries, rebalanced once a year.",
                    "The bond leg is an approximation: a constant-maturity ten-year bond priced off Shiller's GS10 yield at each year end, ignoring roll-down along the curve. It is the weakest input in this episode.",
                    "The withdrawal is taken at the START of each year, before that year's return. This is the conservative ordering and the one the original studies used.",
                    "Annual steps, January to January. No mid-year rebalancing and no cash buffer.",
                    "No taxes, no fees, no Social Security, no pension, no spending flexibility of any kind.",
                    "US large-cap index only (S&P Composite) for the stock leg.",
                    "Retirement cohorts overlap, so 100+ start years are not 100 independent trials.",
                },
            },

            baseCase = new { stockShare = Base, horizonYears = Horizon },
            byRate,
            byMix,
            byHorizon,
            timeline,
            worstCohorts = worst,
            safeRate = new
            {
                rate = safe,
                horizonYears = Horizon,
                stockShare = Base,
                note = "Highest rate at which every cohort in the sample survived.",
            },
            sequenceRisk = new
            {
                startYear = worstYear,
                forwardFinalMultiple = forward,
                reversedFinalMultiple = reversed,
                note = "Identical years and identical average return; only the order differs.",
            },
            headline = new
            {
                rate = 0.04,
                successRate = four.SuccessRate,
                failures = four.Failures,
                cohorts = four.Cohorts,
                medianFinalMultiple = four.MedianFinalMultiple,
                safeRate = safe,
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

        Report(byRate, byMix, byHorizon, worst, safe, worstYear, forward, reversed);
    }

    /// <summary>
    /// Render input for the engine cut. Writes ONLY its own file, so paths can be
    /// regenerated as often as the video needs without any risk of moving a
    /// pinned figure in results.json. Same separation as ep05's ep05-batch, and
    /// for the same reason: that separation is what let ep05's visuals be rebuilt
    /// a dozen times without re-opening a single published number.
    /// </summary>
    public static void WriteBatch(string snapshotDir, string outputPath)
    {
        var series = ShillerSeries.Load(Path.Combine(snapshotDir, "shiller-monthly.csv"));
        var sim = new Retirement(series);
        const double Rate = 0.04;

        var runs = sim.AllCohorts(Rate, Horizon, Base);
        var cohorts = runs.Select(r => new
        {
            startYear = r.StartYear,
            survived = r.Survived,
            depletedInYear = r.DepletedInYear,
            finalMultiple = r.FinalRealMultiple,
            path = sim.PathFor(r.StartYear, Rate, Horizon, Base),
        }).ToArray();

        // D1, the gate that catches the one way this file can silently disagree
        // with the published result: the last point of every path must be the
        // final multiple Run reported. Checked here rather than trusted.
        double worstDelta = cohorts.Max(c => Math.Abs(c.path[^1] - c.finalMultiple));
        if (worstDelta > 1e-12)
            throw new InvalidOperationException($"path endpoints disagree with Run by {worstDelta}");

        // The withdrawal rate as an operated control. Quarter-point detents plus
        // the exact safe rate, so the dial can rest on the real answer instead of
        // on the nearest round number near it.
        double safe = sim.SafeRate(Horizon, Base);
        var rateGrid = new List<double>();
        for (double r = 0.030; r <= 0.06001; r += 0.0025) rateGrid.Add(Math.Round(r, 6));
        // NOT rounded. meta.safeRate carries full precision, and rounding the
        // grid entry to ten places made the two differ by about 1e-11, so a
        // consumer looking up "the detent at the safe rate" had to guess a
        // tolerance. The renderer and the validator both do that lookup.
        rateGrid.Add(safe);
        // Each detent carries where all 126 END at that setting, not just the
        // aggregate. Without them a dial is a readout with a number beside it;
        // with them, turning the dial makes the population itself move and the
        // failures visibly drop onto the floor. The claim becomes something the
        // frame does rather than something it prints.
        var rateSweep = rateGrid.Distinct().OrderBy(r => r)
            .Select(r => new { rate = r, res = sim.ByRate(r, Horizon, Base), runs = sim.AllCohorts(r, Horizon, Base) })
            .Select(x => new
            {
                rate = x.res.Rate,
                failures = x.res.Failures,
                cohorts = x.res.Cohorts,
                successRate = x.res.SuccessRate,
                medianFinalMultiple = x.res.MedianFinalMultiple,
                finalMultiples = x.runs.Select(r => r.FinalRealMultiple).ToArray(),
            }).ToArray();
        foreach (var s in rateSweep)
        {
            if (s.finalMultiples.Length != s.cohorts)
                throw new InvalidOperationException($"rate {s.rate}: {s.finalMultiples.Length} finals for {s.cohorts} cohorts");
            if (s.finalMultiples.Count(v => v <= 0) != s.failures)
                throw new InvalidOperationException($"rate {s.rate}: zero-count disagrees with reported failures");
        }

        // The stock share as a second control. Same detent discipline.
        var mixGrid = new List<double>();
        for (double m = 0.0; m <= 1.0001; m += 0.05) mixGrid.Add(Math.Round(m, 4));
        var mixSweep = mixGrid
            .Select(m => new { m, res = sim.ByMix(m, Rate, Horizon), runs = sim.AllCohorts(Rate, Horizon, m) })
            .Select(x => new
            {
                stockShare = x.res.StockShare,
                successRate = x.res.SuccessRate,
                medianFinalMultiple = x.res.MedianFinalMultiple,
                failures = x.runs.Count(r => !r.Survived),
                finalMultiples = x.runs.Select(r => r.FinalRealMultiple).ToArray(),
            }).ToArray();
        foreach (var s in mixSweep)
        {
            double reported = 1.0 - s.successRate;
            double counted = (double)s.failures / s.finalMultiples.Length;
            if (Math.Abs(reported - counted) > 1e-12)
                throw new InvalidOperationException($"mix {s.stockShare}: failure count disagrees with success rate");
        }

        // Sequence risk as two PATHS rather than two endpoints, because the claim
        // is about the shape of the journey and the endpoints alone cannot show
        // it. Built from the identical year rows in opposite order.
        var worstYear = sim.WorstCohorts(Rate, Horizon, Base, 1)[0].StartYear;
        var (forward, reversed) = sim.SequenceTest(worstYear, Rate, Horizon, Base);
        var forwardPath = sim.PathFor(worstYear, Rate, Horizon, Base);
        var reversedPath = sim.ReversedPathFor(worstYear, Rate, Horizon, Base);
        if (Math.Abs(forwardPath[^1] - forward) > 1e-12 || Math.Abs(reversedPath[^1] - reversed) > 1e-12)
            throw new InvalidOperationException("sequence paths disagree with SequenceTest");

        var batch = new
        {
            meta = new
            {
                note = "Renderer input only. Modelled retirements, not people or recorded events.",
                rate = Rate,
                horizonYears = Horizon,
                stockShare = Base,
                firstYear = sim.FirstYear,
                lastYear = sim.LastYear,
                safeRate = safe,
            },
            cohorts,
            rateSweep,
            mixSweep,
            sequence = new
            {
                startYear = worstYear,
                forwardFinalMultiple = forward,
                reversedFinalMultiple = reversed,
                forwardPath,
                reversedPath,
            },
        };

        var json = JsonSerializer.Serialize(batch, new JsonSerializerOptions
        {
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        });
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        File.WriteAllText(outputPath, json);
        Console.WriteLine($"wrote {outputPath}");
        Console.WriteLine($"  {cohorts.Length} cohorts, {cohorts.Count(c => !c.survived)} depleted, "
            + $"D1 worst path/endpoint delta {worstDelta:E1}");
        Console.WriteLine($"  rate sweep {rateSweep.Length} detents, mix sweep {mixSweep.Length} detents");
        Console.WriteLine($"  sequence {worstYear}: forward {forward:F4}, reversed {reversed:F4}");
    }

    private static void Report(
        IReadOnlyList<RateResult> byRate, IReadOnlyList<MixResult> byMix,
        IReadOnlyList<RateResult> byHorizon, IReadOnlyList<RetirementRun> worst,
        double safe, int worstYear, double forward, double reversed)
    {
        Console.WriteLine();
        Console.WriteLine($"SUCCESS BY WITHDRAWAL RATE, 30 years, 60/40");
        Console.WriteLine("  rate    cohorts   survived   failures   median ending    10th pct");
        foreach (var r in byRate)
        {
            Console.WriteLine(
                $"  {r.Rate,5:P1}   {r.Cohorts,6}   {r.SuccessRate,8:P1}   {r.Failures,8}   {r.MedianFinalMultiple,13:F2}x   {r.P10FinalMultiple,8:F2}x");
        }

        Console.WriteLine();
        Console.WriteLine("SUCCESS AT 4% BY STOCK SHARE, 30 years");
        foreach (var m in byMix)
            Console.WriteLine($"  {m.StockShare,5:P0} stocks   survived {m.SuccessRate,7:P1}   median ending {m.MedianFinalMultiple,7:F2}x");

        Console.WriteLine();
        Console.WriteLine("SUCCESS AT 4% BY HORIZON, 60/40");
        foreach (var h in byHorizon)
            Console.WriteLine($"  {h.Horizon,2} years   cohorts {h.Cohorts,4}   survived {h.SuccessRate,7:P1}   median ending {h.MedianFinalMultiple,7:F2}x");

        Console.WriteLine();
        Console.WriteLine("WORST COHORTS AT 4%, 30 years, 60/40");
        Console.WriteLine("  retires in   survived   ended with   ran out in");
        foreach (var w in worst)
        {
            Console.WriteLine(
                $"  {w.StartYear,10}   {(w.Survived ? "yes" : "NO"),8}   {w.FinalRealMultiple,10:F2}x   {(w.DepletedInYear?.ToString() ?? "-"),10}");
        }

        Console.WriteLine();
        Console.WriteLine($"SAFE RATE (every cohort survives 30 years, 60/40): {safe:P2}");
        Console.WriteLine();
        Console.WriteLine($"SEQUENCE TEST on the worst cohort ({worstYear}), same years reordered:");
        Console.WriteLine($"  forward  {forward:F2}x");
        Console.WriteLine($"  reversed {reversed:F2}x");
    }
}
