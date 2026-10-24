namespace RunTheNumbers.Sim;

public sealed record TermRun(
    string StartMonth, double Rate15, double Rate30, double SpreadPp,
    int HorizonYears,
    double FifteenNetReal, double ThirtyNetReal, double HybridNetReal,
    int HybridPayoffMonth,
    bool ThirtyWon, double GapShare, double FlexCostShare);

public sealed record TermBucket(
    double RateLow, double RateHigh, int Cohorts, double ThirtyWinRate,
    double MedianGapShare, double P10GapShare, double P90GapShare);

/// <summary>
/// Episode 7 - the 15-year against the 30-year mortgage.
/// </summary>
/// <remarks>
/// Three borrowers buy the same house with the same loan in the same month and
/// spend exactly the same cash every month afterwards: the 15-year payment.
///
///   FIFTEEN pays the 15-year loan; once it dies, the whole payment goes to the
///   market for the rest of the horizon.
///   THIRTY pays the 30-year payment and puts the difference in the market every
///   month without fail - the most generous honest version of that strategy.
///   HYBRID takes the 30-year loan but pays the 15-year amount into it. The only
///   thing separating HYBRID from FIFTEEN is the rate spread, which makes it the
///   clean price tag on the 30's flexibility option when the option never gets
///   used.
///
/// The house cancels exactly - all three own it outright by the end - so it never
/// enters the comparison and no appreciation is assumed. Everything runs in
/// NOMINAL terms and is deflated once at the end, because a fixed payment is
/// fixed in nominal dollars and inflation quietly works for the borrower - for
/// thirty years on one path and fifteen on the other.
/// </remarks>
public sealed class Mortgage15v30
{
    private readonly List<(string Month, double NominalEquity, double Cpi, double? R30, double? R15)> _m = [];

    public Mortgage15v30(ShillerSeries shiller, FredHousing fred)
    {
        var rates = fred.Months.ToDictionary(x => x.Month, x => (x.Mortgage30, x.Mortgage15));

        foreach (var s in shiller.Months)
        {
            if (s.Cpi is not { } cpi) continue;
            // Shiller's CPI deflates, exactly as in ep05, so the equity index and
            // the deflator come from one source. It also sidesteps the documented
            // official blank at 2025-10 in the FRED CPI series.
            var (r30, r15) = rates.GetValueOrDefault(s.Date);
            _m.Add((s.Date, s.RealTotalReturnPrice * cpi, cpi, r30, r15));
        }
    }

    public string FirstPairMonth => _m.First(x => x.R15 is not null && x.R30 is not null).Month;
    public string LastMonth => _m[^1].Month;

    /// <summary>Standard fully amortising monthly payment on a principal of 1.</summary>
    public static double Payment(double monthlyRate, int months) =>
        monthlyRate <= 0 ? 1.0 / months : monthlyRate / (1 - Math.Pow(1 + monthlyRate, -months));

    private struct Leg
    {
        public double Bal, Port;
        public int Payoff;
    }

    /// <summary>
    /// One month of one strategy. Contribution first, then growth, matching ep05's
    /// mechanics so the two episodes cannot drift apart. In the payoff month the
    /// overshoot joins that month's contribution.
    /// </summary>
    private static void Step(ref Leg leg, double mr, double loanPay, double investWhile, double investAfter, double g, int i)
    {
        double contrib;
        if (leg.Bal > 0)
        {
            leg.Bal += leg.Bal * mr - loanPay;
            if (leg.Bal <= 0)
            {
                contrib = investWhile - leg.Bal;
                leg.Bal = 0;
                leg.Payoff = i + 1;
            }
            else
            {
                contrib = investWhile;
            }
        }
        else
        {
            contrib = investAfter;
        }
        leg.Port = (leg.Port + contrib) * g;
    }

    /// <summary>
    /// The mechanics, shared by the historical run and the break-even solver so
    /// neither can drift from the other.
    /// </summary>
    private static (double Fifteen, double Thirty, double Hybrid, int HybridPayoff) Play(
        double r15, double r30, int months, Func<int, double> growth)
    {
        double pay15 = Payment(r15, 180);
        double pay30 = Payment(r30, 360);
        double diff = pay15 - pay30;

        var fifteen = new Leg { Bal = 1.0 };
        var thirty = new Leg { Bal = 1.0 };
        var hybrid = new Leg { Bal = 1.0 };

        for (int i = 0; i < months; i++)
        {
            double g = growth(i);
            Step(ref fifteen, r15, pay15, 0, pay15, g, i);
            Step(ref thirty, r30, pay30, diff, pay15, g, i);
            Step(ref hybrid, r30, pay15, 0, pay15, g, i);
        }

        return (fifteen.Port - fifteen.Bal, thirty.Port - thirty.Bal, hybrid.Port - hybrid.Bal, hybrid.Payoff);
    }

    /// <summary>
    /// The steady annual nominal return at which THIRTY ties FIFTEEN. Below it the
    /// forced-march 15 wins, above it the invested difference wins. This is the
    /// half of the episode that needs no data: today's rate pair does not exist in
    /// the completed-window record, but the arithmetic answers it anyway.
    /// </summary>
    public static double BreakEvenAnnualReturn(double rate15, double rate30, int horizonYears)
    {
        double r15 = rate15 / 100.0 / 12.0;
        double r30 = rate30 / 100.0 / 12.0;
        int months = horizonYears * 12;

        double Gap(double annual)
        {
            double g = Math.Pow(1 + annual, 1.0 / 12.0);
            var (fifteen, thirty, _, _) = Play(r15, r30, months, _ => g);
            return thirty - fifteen;
        }

        double lo = -0.50, hi = 0.60;
        if (Gap(lo) > 0 || Gap(hi) < 0) return double.NaN;
        for (int i = 0; i < 200; i++)
        {
            double mid = (lo + hi) / 2;
            if (Gap(mid) < 0) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    /// <summary>
    /// Pure amortisation, no market anywhere: pay the 15-year amount into a
    /// 30-year loan and see when it dies and what the detour cost. The extra
    /// months and the extra cash are the full price of keeping the downshift
    /// option without ever using it.
    /// </summary>
    public static (int PayoffMonths, double ExtraCostShare) HybridArithmetic(double rate15, double rate30)
    {
        double r30 = rate30 / 100.0 / 12.0;
        double pay15 = Payment(rate15 / 100.0 / 12.0, 180);

        double bal = 1.0;
        int m = 0;
        double paid = 0;
        while (bal > 0)
        {
            bal += bal * r30 - pay15;
            m++;
            paid += pay15 + Math.Min(bal, 0); // final month pays only what remains
            if (bal <= 0) bal = 0;
            if (m > 1200) return (-1, double.NaN); // payment does not cover interest
        }
        return (m, paid - 180 * pay15);
    }

    /// <summary>One origination month, all three strategies, equal cash.</summary>
    public TermRun? Run(int start, int horizonYears)
    {
        int months = horizonYears * 12;
        if (start + months >= _m.Count) return null;
        if (_m[start].R15 is not { } rate15 || _m[start].R30 is not { } rate30) return null;

        var (fifteen, thirty, hybrid, hybridPayoff) = Play(
            rate15 / 100.0 / 12.0, rate30 / 100.0 / 12.0, months,
            i => _m[start + i + 1].NominalEquity / _m[start + i].NominalEquity);

        double deflator = _m[start + months].Cpi / _m[start].Cpi;
        double fifteenReal = fifteen / deflator;
        double thirtyReal = thirty / deflator;
        double hybridReal = hybrid / deflator;

        return new TermRun(
            _m[start].Month, rate15, rate30, rate30 - rate15, horizonYears,
            fifteenReal, thirtyReal, hybridReal, hybridPayoff,
            thirtyReal > fifteenReal,
            thirtyReal - fifteenReal,
            fifteenReal - hybridReal);
    }

    /// <summary>
    /// The same cohort replayed with every month's growth replaced by the
    /// window's own average, so the RETURN is identical and only its ORDER
    /// changes. The realized gap minus this steady gap is sequence luck,
    /// isolated: how much of the outcome came from WHEN the returns landed
    /// rather than how big they were.
    /// </summary>
    public (double RealizedCagr, double SteadyGapShare)? SteadyCounterfactual(int start, int horizonYears)
    {
        int months = horizonYears * 12;
        if (start + months >= _m.Count) return null;
        if (_m[start].R15 is not { } rate15 || _m[start].R30 is not { } rate30) return null;

        double total = _m[start + months].NominalEquity / _m[start].NominalEquity;
        double g = Math.Pow(total, 1.0 / months);

        var (fifteen, thirty, _, _) = Play(
            rate15 / 100.0 / 12.0, rate30 / 100.0 / 12.0, months, _ => g);

        double deflator = _m[start + months].Cpi / _m[start].Cpi;
        return (Math.Pow(g, 12) - 1, (thirty - fifteen) / deflator);
    }

    public IReadOnlyList<TermRun> AllCohorts(int horizonYears)
    {
        var runs = new List<TermRun>();
        for (int i = 0; i < _m.Count; i++)
        {
            var run = Run(i, horizonYears);
            if (run is not null) runs.Add(run);
        }
        return runs;
    }

    public IReadOnlyList<TermBucket> ByRateBucket(int horizonYears, double[] edges)
    {
        var runs = AllCohorts(horizonYears);
        var buckets = new List<TermBucket>();
        for (int b = 0; b + 1 < edges.Length; b++)
        {
            var slice = runs.Where(x => x.Rate30 >= edges[b] && x.Rate30 < edges[b + 1]).ToList();
            if (slice.Count == 0) continue;
            var gaps = slice.Select(x => x.GapShare).OrderBy(v => v).ToList();
            buckets.Add(new TermBucket(
                edges[b], edges[b + 1], slice.Count,
                (double)slice.Count(x => x.ThirtyWon) / slice.Count,
                Stats.Median(gaps), Stats.Percentile(gaps, 0.10), Stats.Percentile(gaps, 0.90)));
        }
        return buckets;
    }

    /// <summary>
    /// Cohorts grouped by when the pair of loans was signed. With one completed
    /// 30-year era in the record, saying which years a number comes from matters
    /// more than the number.
    /// </summary>
    public IReadOnlyList<object> ByEra(int horizonYears, int span)
    {
        var runs = AllCohorts(horizonYears);
        return runs
            .GroupBy(x => int.Parse(x.StartMonth[..4]) / span * span)
            .OrderBy(g => g.Key)
            .Select(g =>
            {
                var gaps = g.Select(x => x.GapShare).OrderBy(v => v).ToList();
                var flex = g.Select(x => x.FlexCostShare).OrderBy(v => v).ToList();
                return (object)new
                {
                    fromYear = g.Key,
                    toYear = g.Max(x => int.Parse(x.StartMonth[..4])),
                    cohorts = g.Count(),
                    rate30Low = g.Min(x => x.Rate30),
                    rate30High = g.Max(x => x.Rate30),
                    thirtyWinRate = (double)g.Count(x => x.ThirtyWon) / g.Count(),
                    medianGapShare = Stats.Median(gaps),
                    medianFlexCostShare = Stats.Median(flex),
                };
            })
            .ToList();
    }

    /// <summary>The measured 30-minus-15 spread, month by month, both rates present.</summary>
    public IReadOnlyList<(string Month, double SpreadPp)> SpreadSeries() =>
        _m.Where(x => x.R15 is not null && x.R30 is not null)
          .Select(x => (x.Month, x.R30!.Value - x.R15!.Value))
          .ToList();
}
