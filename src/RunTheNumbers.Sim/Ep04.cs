using System.Text.Json;
using System.Text.Json.Serialization;

namespace RunTheNumbers.Sim;

/// <summary>Episode 4 - rent or buy, on the matched metro panel.</summary>
public static class Ep04
{
    private const string WindowStart = "2018-01";
    private const string WindowEnd = "2026-03";
    private const string LongStart = "2015-01";
    private const int BaseHold = 5;

    private static IReadOnlyList<HousingMetro> AssertPanel(
        HousingPanel panel, string start, string end, int expected)
    {
        var metros = panel.CompleteWindow(start, end);
        if (metros.Count != expected)
        {
            foreach (var m in panel.Matched)
                if (panel.CoverageGaps(m, start, end) is { } gapNote)
                    Console.WriteLine($"  {m.Name}, {m.State} (rank {m.SizeRank}): {gapNote}");
            throw new InvalidOperationException(
                $"panel {start}..{end}: expected {expected} strict-monthly metros, derived {metros.Count}");
        }
        return metros;
    }

    public static void Run(string snapshotDir, string fredDir, string housingDir, string outputPath)
    {
        var shiller = ShillerSeries.Load(Path.Combine(snapshotDir, "shiller-monthly.csv"));
        var fred = FredHousing.Load(fredDir);
        var panel = HousingPanel.Load(housingDir);
        var manifest = JsonSerializer.Deserialize<JsonElement>(
            File.ReadAllText(Path.Combine(snapshotDir, "manifest.json")));
        var fredManifest = JsonSerializer.Deserialize<JsonElement>(
            File.ReadAllText(Path.Combine(fredDir, "manifest.json")));
        var housingManifest = JsonSerializer.Deserialize<JsonElement>(
            File.ReadAllText(Path.Combine(housingDir, "manifest.json")));

        // C4's coverage table says 255 metros for this window, but that count is
        // span-based (first..last observation). Fourteen of those spans have
        // holes inside them - a missing ZHVI month in San Jose, a missing FHFA
        // quarter in Ithaca - and this ledger needs every month, with the C1
        // precedent (the blank 2025-10 CPI) forbidding interpolation. So the
        // simulation panel is the strict-monthly 241, and the difference is
        // recorded as a finding for the data lane in TASKS.md, not patched here.
        var metros = AssertPanel(panel, WindowStart, WindowEnd, expected: 241);
        var metrosLong = AssertPanel(panel, LongStart, WindowEnd, expected: 181);

        var sim = new RentVsBuy(panel, fred, shiller);
        int a0 = HousingPanel.MonthIndex(WindowStart);
        int b0 = HousingPanel.MonthIndex(WindowEnd);
        int aLong = HousingPanel.MonthIndex(LongStart);

        int[] holds = [2, 3, 4, 5, 6, 7, 8];
        RvbAssumptions[] bundles =
            [RvbAssumptions.Base, RvbAssumptions.LowOwnerCost, RvbAssumptions.HighOwnerCost, RvbAssumptions.OldHomeStress];

        object Aggregate(int holdYears, List<RvbRun> runs) => new
        {
            holdYears,
            runs = runs.Count,
            cohortMonths = runs.Select(r => r.StartMonth).Distinct().Count(),
            buyWinRate = (double)runs.Count(r => r.BuyWon) / runs.Count,
            medianGapShare = Stats.Median(runs.Select(r => r.GapShare).OrderBy(v => v).ToList()),
            p10GapShare = Stats.Percentile(runs.Select(r => r.GapShare).OrderBy(v => v).ToList(), 0.10),
            p90GapShare = Stats.Percentile(runs.Select(r => r.GapShare).OrderBy(v => v).ToList(), 0.90),
        };

        // Base case across the holding-period axis; keep the base-hold runs.
        var baseByHold = new List<object>();
        List<RvbRun> baseRuns = [];
        foreach (var h in holds)
        {
            var runs = sim.AllRuns(metros, a0, b0, h, RvbAssumptions.Base);
            if (h == BaseHold) baseRuns = runs;
            baseByHold.Add(Aggregate(h, runs));
        }

        var names = metros.ToDictionary(m => m.RegionId, m => m);

        var byMetro = baseRuns.GroupBy(r => r.RegionId).Select(g => new
        {
            regionId = g.Key,
            metro = names[g.Key].Name,
            state = names[g.Key].State,
            sizeRank = names[g.Key].SizeRank,
            cohorts = g.Count(),
            buyWinRate = (double)g.Count(r => r.BuyWon) / g.Count(),
            medianGapShare = Stats.Median(g.Select(r => r.GapShare).OrderBy(v => v).ToList()),
            startRentYield = Stats.Median(g.Select(r => r.StartRentYield).OrderBy(v => v).ToList()),
        }).OrderBy(x => x.sizeRank).ToArray();

        var byCohort = baseRuns.GroupBy(r => r.StartMonth).OrderBy(g => g.Key).Select(g => new
        {
            month = HousingPanel.MonthString(g.Key),
            ratePercent = g.First().RatePercent,
            metros = g.Count(),
            buyWinRate = (double)g.Count(r => r.BuyWon) / g.Count(),
            medianGapShare = Stats.Median(g.Select(r => r.GapShare).OrderBy(v => v).ToList()),
        }).ToArray();

        var scenarioTable = bundles.Select(bundle => new
        {
            scenario = bundle.Name,
            propertyTax = bundle.PropertyTax,
            insurance = bundle.Insurance,
            maintenance = bundle.Maintenance,
            buyCost = bundle.BuyCost,
            sellCost = bundle.SellCost,
            byHold = holds.Select(h => Aggregate(h, sim.AllRuns(metros, a0, b0, h, bundle))).ToArray(),
        }).ToArray();

        double[] sellCosts = [0.05, 0.07, 0.10, 0.12];
        var sellAxis = sellCosts.Select(s => new
        {
            sellCost = s,
            atBaseHold = Aggregate(BaseHold,
                sim.AllRuns(metros, a0, b0, BaseHold, RvbAssumptions.Base with { SellCost = s })),
        }).ToArray();

        // Construction sensitivity: same runs, FHFA quarterly path instead of
        // the ZHVI monthly path. Pre-registered in model-choice.md.
        var fhfaRuns = sim.AllRuns(metros, a0, b0, BaseHold, RvbAssumptions.Base, fhfaPath: true);
        var paired = baseRuns.Join(fhfaRuns,
            r => (r.RegionId, r.StartMonth), r => (r.RegionId, r.StartMonth),
            (z, f) => (z, f)).ToList();
        var disagreements = paired.Where(p => p.z.BuyWon != p.f.BuyWon).ToList();
        var fhfaSensitivity = new
        {
            holdYears = BaseHold,
            zhviBuyWinRate = (double)baseRuns.Count(r => r.BuyWon) / baseRuns.Count,
            fhfaBuyWinRate = (double)fhfaRuns.Count(r => r.BuyWon) / fhfaRuns.Count,
            verdictAgreementRate = 1.0 - (double)disagreements.Count / paired.Count,
            disagreeingRuns = disagreements.Count,
            metrosWithAnyDisagreement = disagreements.Select(d => names[d.z.RegionId].Name).Distinct().Count(),
        };

        // The 2015-01 long-hold panel: fewer metros, one more rate era, and the
        // only place holds past eight years exist. A robustness read, not the base.
        var longByHold = Enumerable.Range(2, 10).Select(h =>
            Aggregate(h, sim.AllRuns(metrosLong, aLong, b0, h, RvbAssumptions.Base))).ToArray();

        // The no-data half: the first-year rent yield at which buying ties, on
        // the same ledger, under steady growth. Portable to any listing: divide
        // a year of rent by the price and compare.
        double[] beRates = [3, 5, 6.5, 7];
        int[] beHolds = [3, 5, 7, 10, 15];
        var breakEven = (
            from rate in beRates
            from h in beHolds
            select new
            {
                ratePercent = rate,
                holdYears = h,
                homeGrowthAnnual = 0.03,
                marketReturnAnnual = 0.07,
                rentGrowthAnnual = 0.03,
                requiredRentYield = RentVsBuy.BreakEvenRentYield(
                    rate, h, RvbAssumptions.Base, 0.03, 0.07, 0.03),
            }).ToArray();

        var bestRun = baseRuns.OrderByDescending(r => r.GapShare).First();
        var worstRun = baseRuns.OrderBy(r => r.GapShare).First();
        var topMetro = byMetro.OrderByDescending(m => m.buyWinRate).First();
        var bottomMetro = byMetro.OrderBy(m => m.buyWinRate).First();
        var gaps = baseRuns.Select(r => r.GapShare).OrderBy(v => v).ToList();

        var result = new
        {
            meta = new
            {
                episode = "ep04-rent-vs-buy",
                generatedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
                snapshot = manifest,
                rateSnapshot = fredManifest,
                housingSnapshot = housingManifest,
                window = new { start = WindowStart, end = WindowEnd, metros = metros.Count },
                longWindow = new { start = LongStart, end = WindowEnd, metros = metrosLong.Count },
                assumptions = new[]
                {
                    "Matched whole-MSA metros only, 2018-01 through 2026-03: 241 metros carry every month of rent, home value, price index and mortgage rate. Thirteen split metros, including many of the largest, are excluded rather than mismatched; fourteen more clear C4's span-based bar but have missing months inside the span, and are excluded rather than interpolated.",
                    "Home value is Zillow's ZHVI (modelled typical home, middle tier); rent is Zillow's ZORI (modelled typical asking rent). They are not the same physical property, and their seasonal treatments differ.",
                    "Both households spend exactly the same cash every month. Whoever pays less that month invests the difference in the S&P Composite with dividends reinvested. The buyer's surplus account exists for the months a locked payment beats rising rents.",
                    "The buyer puts 20% down, pays 2.5% closing on the way in and 7% selling costs on the way out. Sale costs land only at exit, which is what makes the holding period load-bearing.",
                    "Ownership costs run monthly against the current home value: 1% property tax, 0.5% insurance, 1% maintenance per year. The C5 memo carries the cited ranges; the sensitivity bundles rerun them.",
                    "30-year fixed at that month's Freddie Mac survey rate. No points, no PMI, no refinancing ever - a 20% down borrower who never refinances through 2020-21 is a conservative construction for buying.",
                    "No federal tax benefit in the base case: most filers take the standard deduction. An itemizer scenario is a panel item, not a base assumption.",
                    "Everything runs in nominal dollars; the verdict is the wealth gap as a share of the starting home price, which is unit-free.",
                    "Start months overlap heavily within a metro and metros move together, so thousands of runs are far fewer independent trials than they look.",
                },
            },

            baseCase = new
            {
                holdYears = BaseHold,
                downPct = RvbAssumptions.Base.Down,
                assumptionBundle = "base",
            },

            byHold = baseByHold,
            byMetro,
            byCohort,
            scenarioTable,
            sellAxis,
            fhfaSensitivity,
            longByHold,
            breakEven,

            headline = new
            {
                runs = baseRuns.Count,
                metros = metros.Count,
                cohortMonths = baseRuns.Select(r => r.StartMonth).Distinct().Count(),
                buyWinRate = (double)baseRuns.Count(r => r.BuyWon) / baseRuns.Count,
                medianGapShare = Stats.Median(gaps),
                p10GapShare = Stats.Percentile(gaps, 0.10),
                p90GapShare = Stats.Percentile(gaps, 0.90),
                best = new { metro = names[bestRun.RegionId].Name, month = HousingPanel.MonthString(bestRun.StartMonth), gapShare = bestRun.GapShare },
                worst = new { metro = names[worstRun.RegionId].Name, month = HousingPanel.MonthString(worstRun.StartMonth), gapShare = worstRun.GapShare },
                topMetro = new { topMetro.metro, topMetro.state, topMetro.buyWinRate },
                bottomMetro = new { bottomMetro.metro, bottomMetro.state, bottomMetro.buyWinRate },
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

        Console.WriteLine();
        Console.WriteLine($"RENT vs BUY, {metros.Count} metros, {WindowStart}..{WindowEnd}, base bundle, {BaseHold}y hold");
        Console.WriteLine($"  runs {baseRuns.Count}, buying won {(double)baseRuns.Count(r => r.BuyWon) / baseRuns.Count:P1}");
        Console.WriteLine($"  median gap {Stats.Median(gaps):F3} of the starting price, p10 {Stats.Percentile(gaps, 0.10):F3}, p90 {Stats.Percentile(gaps, 0.90):F3}");
        Console.WriteLine($"  best  {result.headline.best.metro} {result.headline.best.month}  {bestRun.GapShare:F3}");
        Console.WriteLine($"  worst {result.headline.worst.metro} {result.headline.worst.month}  {worstRun.GapShare:F3}");

        Console.WriteLine();
        Console.WriteLine("BY HOLDING PERIOD (base bundle)");
        Console.WriteLine("  hold   runs   cohort months   buy won   median gap");
        foreach (var h in holds)
        {
            var runs = sim.AllRuns(metros, a0, b0, h, RvbAssumptions.Base);
            Console.WriteLine($"  {h,2}y   {runs.Count,6}   {runs.Select(r => r.StartMonth).Distinct().Count(),8}   {(double)runs.Count(r => r.BuyWon) / runs.Count,7:P1}   {Stats.Median(runs.Select(r => r.GapShare).OrderBy(v => v).ToList()),8:F3}");
        }

        Console.WriteLine();
        Console.WriteLine("SCENARIOS at 5y (C5 bundles)");
        foreach (var s in scenarioTable)
        {
            var h5 = sim.AllRuns(metros, a0, b0, BaseHold, bundles.First(b => b.Name == s.scenario));
            Console.WriteLine($"  {s.scenario,-16}  buy won {(double)h5.Count(r => r.BuyWon) / h5.Count,7:P1}");
        }

        Console.WriteLine();
        Console.WriteLine($"FHFA-path check at {BaseHold}y: zhvi {fhfaSensitivity.zhviBuyWinRate:P1} vs fhfa {fhfaSensitivity.fhfaBuyWinRate:P1}, agreement {fhfaSensitivity.verdictAgreementRate:P1} ({fhfaSensitivity.disagreeingRuns} runs, {fhfaSensitivity.metrosWithAnyDisagreement} metros)");

        Console.WriteLine();
        Console.WriteLine("METRO EXTREMES at 5y");
        Console.WriteLine($"  most pro-buy  {topMetro.metro}, {topMetro.state}: {topMetro.buyWinRate:P1}");
        Console.WriteLine($"  most pro-rent {bottomMetro.metro}, {bottomMetro.state}: {bottomMetro.buyWinRate:P1}");

        Console.WriteLine();
        Console.WriteLine("BREAK-EVEN RENT YIELD (steady 3% home, 7% market)");
        Console.WriteLine("  rate    3y      5y      7y     10y     15y");
        foreach (var rate in beRates)
        {
            var row = beHolds.Select(h => breakEven.First(x => x.ratePercent == rate && x.holdYears == h).requiredRentYield);
            Console.WriteLine($"  {rate,4:F1}%  " + string.Join("  ", row.Select(v => $"{v,5:P1}")));
        }
    }
}
