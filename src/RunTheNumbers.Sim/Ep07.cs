using System.Text.Json;
using System.Text.Json.Serialization;

namespace RunTheNumbers.Sim;

/// <summary>Episode 7 - the 15-year against the 30-year mortgage.</summary>
public static class Ep07
{
    private sealed record PathVsSteadyRow(
        string Month, double Rate30, double RealizedCagr, double RequiredReturn,
        double RealizedGapShare, double SteadyGapShare, double SequencePenalty,
        bool ThirtyWinsIfSteady);

    public static void Run(string snapshotDir, string fredDir, string outputPath)
    {
        var shiller = ShillerSeries.Load(Path.Combine(snapshotDir, "shiller-monthly.csv"));
        var fred = FredHousing.Load(fredDir);
        var manifest = JsonSerializer.Deserialize<JsonElement>(
            File.ReadAllText(Path.Combine(snapshotDir, "manifest.json")));
        var fredManifest = JsonSerializer.Deserialize<JsonElement>(
            File.ReadAllText(Path.Combine(fredDir, "manifest.json")));

        var sim = new Mortgage15v30(shiller, fred);
        Console.WriteLine($"rate pairs from {sim.FirstPairMonth}, equities to {sim.LastMonth}");

        var thirtyYear = sim.AllCohorts(30);
        var twentyYear = sim.AllCohorts(20);
        var fifteenYear = sim.AllCohorts(15);

        var spread = sim.SpreadSeries();
        var spreadValues = spread.Select(x => x.SpreadPp).OrderBy(v => v).ToList();

        // The half of the episode that needs no data. Completed 30-year windows
        // exist only for 1991-96 originations at 6.8%+ rates, so the pairs most
        // borrowers actually hold are answered by arithmetic, not history.
        double[] rate30Grid = [3, 4, 5, 6, 7, 8, 9, 10];
        double[] spreadGrid = [0.25, 0.50, 0.75, 1.00];
        var breakEven = (
            from r30 in rate30Grid
            from sp in spreadGrid
            let r15 = r30 - sp
            let pay15 = Mortgage15v30.Payment(r15 / 100 / 12, 180)
            let pay30 = Mortgage15v30.Payment(r30 / 100 / 12, 360)
            let hybrid = Mortgage15v30.HybridArithmetic(r15, r30)
            select new
            {
                rate30Percent = r30,
                spreadPp = sp,
                rate15Percent = r15,
                paymentRatio = pay15 / pay30,
                monthlyDiffShare = pay15 - pay30,
                requiredAnnualReturn30y = Mortgage15v30.BreakEvenAnnualReturn(r15, r30, 30),
                hybridPayoffMonths = hybrid.PayoffMonths,
                hybridExtraMonths = hybrid.PayoffMonths - 180,
                hybridExtraCostShare = hybrid.ExtraCostShare,
                inHistoricalSample = thirtyYear.Any(c => Math.Abs(c.Rate30 - r30) < 0.5),
            }).ToArray();

        var gaps30 = thirtyYear.Select(x => x.GapShare).OrderBy(v => v).ToList();
        var flex30 = thirtyYear.Select(x => x.FlexCostShare).OrderBy(v => v).ToList();
        var net15at15 = fifteenYear.Select(x => x.ThirtyNetReal).OrderBy(v => v).ToList();

        var worst30 = thirtyYear.Count == 0 ? null : thirtyYear.OrderBy(x => x.GapShare).First();
        var best30 = thirtyYear.Count == 0 ? null : thirtyYear.OrderByDescending(x => x.GapShare).First();

        // Sequence luck, isolated. Each completed window replayed with its own
        // average return every month: same return, different order. If THIRTY
        // wins the steady replay and lost the real one, the loss came from WHEN
        // the returns landed, not from how big they were - and that distinction
        // is the honest core of this episode.
        var pathVsSteady = new List<PathVsSteadyRow>();
        for (int i = 0; i < 10000; i++)
        {
            var run = sim.Run(i, 30);
            if (run is null) continue;
            if (sim.SteadyCounterfactual(i, 30) is not { } s) continue;
            pathVsSteady.Add(new PathVsSteadyRow(
                run.StartMonth,
                run.Rate30,
                Math.Round(s.RealizedCagr, 4),
                Math.Round(Mortgage15v30.BreakEvenAnnualReturn(run.Rate15, run.Rate30, 30), 4),
                Math.Round(run.GapShare, 4),
                Math.Round(s.SteadyGapShare, 4),
                Math.Round(run.GapShare - s.SteadyGapShare, 4),
                s.SteadyGapShare > 0));
        }
        if (pathVsSteady.Count != thirtyYear.Count)
            throw new InvalidOperationException(
                $"pathVsSteady rows ({pathVsSteady.Count}) do not match 30-year cohorts ({thirtyYear.Count})");

        var result = new
        {
            meta = new
            {
                episode = "ep07-15-vs-30-year",
                generatedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
                snapshot = manifest,
                rateSnapshot = fredManifest,
                firstPairMonth = sim.FirstPairMonth,
                lastMonth = sim.LastMonth,
                assumptions = new[]
                {
                    "Same house, same loan, same month, and all three borrowers own it outright by the end, so the house cancels exactly and no appreciation is assumed.",
                    "Equal cash every month on every path: the budget is the 15-year payment. The 30-year borrower invests the difference every month without fail, which is the most generous honest version of that strategy.",
                    "Everything runs in nominal dollars and is deflated once at the end. Fixed payments are fixed in nominal terms, so inflation works for the borrower, and it works longer on the 30-year path.",
                    "Both rates are that month's average Freddie Mac survey rate. The 15-year series begins 1991-09, so the sample starts there. No points, no fees, no refinancing, ever.",
                    "Investments are the S&P Composite with dividends reinvested, no fees. Shiller's CPI is the deflator, so the index and the deflator share one source; the official October 2025 CPI blank never enters.",
                    "No taxes on either path. The mortgage interest deduction favours the 30-year and capital gains tax favours the 15-year, so they push in opposite directions and both are omitted.",
                    "The hybrid takes the 30-year loan and pays the 15-year amount into it. The only thing separating it from the true 15 is the rate spread, so their gap is the exact price of the never-used flexibility option.",
                    "Originations overlap heavily, and every completed 30-year window was signed 1991-1996 - one economic era, not a sample of eras.",
                    "Freddie Mac changed its survey methodology on 2022-11-17, so observations either side are not perfectly comparable.",
                },
            },

            spreadSummary = new
            {
                months = spread.Count,
                medianPp = Stats.Median(spreadValues),
                p10Pp = Stats.Percentile(spreadValues, 0.10),
                p90Pp = Stats.Percentile(spreadValues, 0.90),
                min = spread.OrderBy(x => x.SpreadPp).Select(x => new { month = x.Month, spreadPp = x.SpreadPp }).First(),
                max = spread.OrderByDescending(x => x.SpreadPp).Select(x => new { month = x.Month, spreadPp = x.SpreadPp }).First(),
                last = new { month = spread[^1].Month, spreadPp = spread[^1].SpreadPp },
            },
            spreadSeries = spread.Select(x => new { month = x.Month, spreadPp = Math.Round(x.SpreadPp, 2) }).ToArray(),

            breakEven,

            headline30y = thirtyYear.Count == 0 ? null : new
            {
                cohorts = thirtyYear.Count,
                firstStart = thirtyYear[0].StartMonth,
                lastStart = thirtyYear[^1].StartMonth,
                thirtyWinRate = (double)thirtyYear.Count(x => x.ThirtyWon) / thirtyYear.Count,
                medianGapShare = Stats.Median(gaps30),
                p10GapShare = Stats.Percentile(gaps30, 0.10),
                p90GapShare = Stats.Percentile(gaps30, 0.90),
                medianFlexCostShare = Stats.Median(flex30),
                medianHybridPayoffMonth = Stats.Median(thirtyYear.Select(x => (double)x.HybridPayoffMonth).OrderBy(v => v).ToList()),
                worst = worst30 is null ? null : new { worst30.StartMonth, worst30.Rate30, worst30.GapShare },
                best = best30 is null ? null : new { best30.StartMonth, best30.Rate30, best30.GapShare },
                thirtyWinRateIfSteady = (double)pathVsSteady.Count(x => x.ThirtyWinsIfSteady) / pathVsSteady.Count,
                medianSequencePenalty = Stats.Median(pathVsSteady.Select(x => x.SequencePenalty).OrderBy(v => v).ToList()),
                medianRealizedCagr = Stats.Median(pathVsSteady.Select(x => x.RealizedCagr).OrderBy(v => v).ToList()),
                medianRequiredReturn = Stats.Median(pathVsSteady.Select(x => x.RequiredReturn).OrderBy(v => v).ToList()),
            },

            pathVsSteady,

            // At the 15-year mark the true 15 sits at exactly zero: house paid,
            // portfolio empty. THIRTY's net position against that zero answers
            // "could the 30-year borrower write the payoff check today and still
            // be ahead?" - the version of the question with a real sample size.
            checkpoint15y = fifteenYear.Count == 0 ? null : new
            {
                cohorts = fifteenYear.Count,
                firstStart = fifteenYear[0].StartMonth,
                lastStart = fifteenYear[^1].StartMonth,
                thirtyAheadRate = (double)fifteenYear.Count(x => x.ThirtyNetReal > 0) / fifteenYear.Count,
                medianThirtyNet = Stats.Median(net15at15),
                p10ThirtyNet = Stats.Percentile(net15at15, 0.10),
                p90ThirtyNet = Stats.Percentile(net15at15, 0.90),
            },

            headline20y = twentyYear.Count == 0 ? null : new
            {
                cohorts = twentyYear.Count,
                thirtyWinRate = (double)twentyYear.Count(x => x.ThirtyWon) / twentyYear.Count,
                medianGapShare = Stats.Median(twentyYear.Select(x => x.GapShare).OrderBy(v => v).ToList()),
            },

            byEra30 = sim.ByEra(30, 2),
            byEra15 = sim.ByEra(15, 5),
            byRateBucket15 = sim.ByRateBucket(15, [0, 3, 4, 5, 6, 7, 8, 10]),

            cohorts30 = thirtyYear.Select(x => new
            {
                month = x.StartMonth,
                rate15 = x.Rate15,
                rate30 = x.Rate30,
                gapShare = Math.Round(x.GapShare, 4),
                flexCostShare = Math.Round(x.FlexCostShare, 4),
                thirtyWon = x.ThirtyWon,
                hybridPayoffMonth = x.HybridPayoffMonth,
            }).ToArray(),

            cohorts15 = fifteenYear.Select(x => new
            {
                month = x.StartMonth,
                rate30 = x.Rate30,
                thirtyNet = Math.Round(x.ThirtyNetReal, 4),
                flexCostShare = Math.Round(x.FlexCostShare, 4),
            }).ToArray(),
        };

        var json = JsonSerializer.Serialize(result, new JsonSerializerOptions
        {
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        });

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        File.WriteAllText(outputPath, json);
        Console.WriteLine($"wrote {outputPath}");

        Console.WriteLine();
        Console.WriteLine("THE SPREAD, 30-year minus 15-year, monthly since 1991-09");
        Console.WriteLine($"  months {spread.Count}, median {Stats.Median(spreadValues):F2}pp, p10 {Stats.Percentile(spreadValues, 0.10):F2}pp, p90 {Stats.Percentile(spreadValues, 0.90):F2}pp");
        Console.WriteLine($"  last month {spread[^1].Month}: {spread[^1].SpreadPp:F2}pp");

        if (thirtyYear.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine("COMPLETED 30-YEAR WINDOWS (equal cash, budget = the 15-year payment)");
            Console.WriteLine($"  cohorts {thirtyYear.Count} ({thirtyYear[0].StartMonth}..{thirtyYear[^1].StartMonth}), THIRTY won {(double)thirtyYear.Count(x => x.ThirtyWon) / thirtyYear.Count:P1}");
            Console.WriteLine($"  median gap {Stats.Median(gaps30):F3} of the loan, p10 {Stats.Percentile(gaps30, 0.10):F3}, p90 {Stats.Percentile(gaps30, 0.90):F3}");
            Console.WriteLine($"  price of the never-used option (15 minus hybrid): median {Stats.Median(flex30):F3} of the loan");
            Console.WriteLine($"  worst for THIRTY: {worst30!.StartMonth} at {worst30.Rate30:F2}%, gap {worst30.GapShare:F3}");
            Console.WriteLine($"  best for THIRTY:  {best30!.StartMonth} at {best30.Rate30:F2}%, gap {best30.GapShare:F3}");
        }

        if (pathVsSteady.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine("SEQUENCE LUCK, ISOLATED (same window, same average return, steady order)");
            Console.WriteLine($"  THIRTY wins the STEADY replay in {(double)pathVsSteady.Count(x => x.ThirtyWinsIfSteady) / pathVsSteady.Count:P1} of windows (realized: {(double)thirtyYear.Count(x => x.ThirtyWon) / Math.Max(1, thirtyYear.Count):P1})");
            Console.WriteLine($"  median realized CAGR {Stats.Median(pathVsSteady.Select(x => x.RealizedCagr).OrderBy(v => v).ToList()):P2} vs median required {Stats.Median(pathVsSteady.Select(x => x.RequiredReturn).OrderBy(v => v).ToList()):P2}");
            Console.WriteLine($"  median sequence penalty {Stats.Median(pathVsSteady.Select(x => x.SequencePenalty).OrderBy(v => v).ToList()):F3} of the loan");
            var pv = pathVsSteady[0];
            Console.WriteLine($"  first cohort {pv.Month}: realized gap {pv.RealizedGapShare:F3}, steady gap {pv.SteadyGapShare:F3}");
        }

        if (fifteenYear.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine("AT THE 15-YEAR MARK (the true 15 sits at exactly zero)");
            Console.WriteLine($"  cohorts {fifteenYear.Count} ({fifteenYear[0].StartMonth}..{fifteenYear[^1].StartMonth})");
            Console.WriteLine($"  THIRTY ahead of the payoff check in {(double)fifteenYear.Count(x => x.ThirtyNetReal > 0) / fifteenYear.Count:P1} of cohorts");
            Console.WriteLine($"  median net {Stats.Median(net15at15):F3} of the loan, p10 {Stats.Percentile(net15at15, 0.10):F3}, p90 {Stats.Percentile(net15at15, 0.90):F3}");
        }

        Console.WriteLine();
        Console.WriteLine("BY ERA SIGNED, 15-year horizon");
        foreach (var e in sim.ByEra(15, 5)) Console.WriteLine("  " + JsonSerializer.Serialize(e));

        Console.WriteLine();
        Console.WriteLine("BREAK-EVEN: steady annual return where THIRTY ties FIFTEEN (30-year horizon)");
        Console.WriteLine("  30yr rate   spread   15yr rate   pay ratio   required return   hybrid payoff   extra cost   in sample?");
        foreach (var b in breakEven)
        {
            Console.WriteLine(
                $"  {b.rate30Percent,7:F2}%   {b.spreadPp,4:F2}pp   {b.rate15Percent,7:F2}%   {b.paymentRatio,7:F3}   {b.requiredAnnualReturn30y,13:P2}   {b.hybridPayoffMonths,6} mo       {b.hybridExtraCostShare,7:F3}   {(b.inHistoricalSample ? "yes" : "NO")}");
        }
    }
}
