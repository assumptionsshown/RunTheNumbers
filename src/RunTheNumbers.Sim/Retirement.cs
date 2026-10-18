using System.Globalization;

namespace RunTheNumbers.Sim;

public sealed record YearRow(int Year, double StockReal, double BondReal, double Inflation);

public sealed record RetirementRun(
    int StartYear, double Rate, int Horizon, double StockShare,
    bool Survived, int? DepletedInYear, double FinalRealMultiple, double WorstRealMultiple);

public sealed record RateResult(
    double Rate, int Horizon, double StockShare, int Cohorts,
    double SuccessRate, int Failures, double MedianFinalMultiple, double P10FinalMultiple);

public sealed record MixResult(double StockShare, double Rate, int Horizon, double SuccessRate, double MedianFinalMultiple);

/// <summary>
/// Episode 6 - the 4% rule, and how much of it is decided by the year you happen
/// to retire in.
/// </summary>
public sealed class Retirement
{
    private readonly List<YearRow> _years = [];

    public Retirement(ShillerSeries series)
    {
        // Annual steps, January to January, because the rule is stated as an
        // annual withdrawal. Everything is carried in REAL terms: a withdrawal
        // that rises with inflation is a constant real withdrawal, so no separate
        // inflation adjustment is needed on the spending side.
        var byJanuary = new Dictionary<int, Month>();
        foreach (var m in series.Months)
        {
            if (!m.Date.EndsWith("-01", StringComparison.Ordinal)) continue;
            byJanuary[int.Parse(m.Date.AsSpan(0, 4), CultureInfo.InvariantCulture)] = m;
        }

        var years = byJanuary.Keys.OrderBy(y => y).ToList();
        for (int i = 0; i + 1 < years.Count; i++)
        {
            int y0 = years[i], y1 = years[i + 1];
            if (y1 != y0 + 1) continue;

            var a = byJanuary[y0];
            var b = byJanuary[y1];
            if (a.Cpi is not { } cpi0 || b.Cpi is not { } cpi1) continue;

            double stockReal = b.RealTotalReturnPrice / a.RealTotalReturnPrice - 1.0;
            double inflation = cpi1 / cpi0 - 1.0;

            // A constant-maturity ten-year bond, one year held, from the yield at
            // each end. This is the standard textbook approximation and it is an
            // approximation: it ignores roll-down along the curve and assumes the
            // coupon is earned smoothly. It is disclosed on the assumption panel
            // rather than buried, because the bond leg is the weakest input here.
            double? bondReal = null;
            if (a.Gs10 is { } y0Pct && b.Gs10 is { } y1Pct)
            {
                double yieldStart = y0Pct / 100.0, yieldEnd = y1Pct / 100.0;
                if (yieldStart > 0)
                {
                    // For a par bond, MODIFIED duration is exactly the annuity
                    // factor (1 - (1+y)^-10) / y; Macaulay is that times (1+y).
                    // Until 2026-10-09 this line called the annuity factor
                    // "macaulay" and divided by (1+y) again, understating the
                    // bond leg's rate sensitivity by a factor (1+y): ~5% at 5%
                    // yields, ~14% in 1981. validate-ep06 copied the same formula,
                    // so only validate-ep06-story (duration summed from cash
                    // flows) caught it. Headline counts unchanged; see TASKS.md.
                    double modified = (1.0 - Math.Pow(1.0 + yieldStart, -10)) / yieldStart;
                    double nominal = yieldStart - modified * (yieldEnd - yieldStart);
                    bondReal = (1.0 + nominal) / (1.0 + inflation) - 1.0;
                }
            }

            // Without a bond yield there is no mixed portfolio to simulate, so the
            // year is dropped rather than silently filled with the stock return.
            if (bondReal is not { } br) continue;
            _years.Add(new YearRow(y0, stockReal, br, inflation));
        }
    }

    public int FirstYear => _years[0].Year;
    public int LastYear => _years[^1].Year;

    /// <summary>
    /// One retirement. Withdraw first, then earn the year's return on what is
    /// left, which is the conservative ordering and the one the original studies
    /// used. Rebalanced annually back to the target mix.
    /// </summary>
    /// <summary>
    /// One retirement. <paramref name="observe"/> is an additive hook for the
    /// renderer and is defaulted off, so a caller that does not pass it gets
    /// byte-identical behaviour to before it existed.
    /// </summary>
    /// <remarks>
    /// The hook exists so the video's per-year path comes from THIS arithmetic
    /// rather than from a second copy of it. A separate path function would
    /// drift from the published result silently, which is the failure mode this
    /// repo has already been caught by once. It is deliberately NOT independent
    /// verification: that is <c>validate-ep06</c>'s job, and it does not exist
    /// yet.
    /// </remarks>
    public RetirementRun Run(int startYear, double rate, int horizon, double stockShare,
        Action<int, double>? observe = null)
    {
        int start = _years.FindIndex(y => y.Year == startYear);
        if (start < 0 || start + horizon > _years.Count)
            throw new ArgumentOutOfRangeException(nameof(startYear), $"{startYear} has no full {horizon}-year window");

        double balance = 1.0;
        double withdrawal = rate;      // constant in real terms, by construction
        double worst = 1.0;
        int? depleted = null;

        observe?.Invoke(0, balance);

        for (int i = 0; i < horizon; i++)
        {
            balance -= withdrawal;
            if (balance <= 0)
            {
                depleted ??= _years[start + i].Year;
                balance = 0;
                worst = 0;
                // The money stays gone. Reporting the remaining years as zero is
                // the honest shape: a depleted retirement does not stop existing,
                // it sits on the floor for the rest of the horizon.
                for (int j = i; j < horizon; j++) observe?.Invoke(j + 1, 0.0);
                break;
            }

            var y = _years[start + i];
            balance *= 1.0 + (stockShare * y.StockReal + (1 - stockShare) * y.BondReal);
            if (balance < worst) worst = balance;
            observe?.Invoke(i + 1, balance);
        }

        return new RetirementRun(startYear, rate, horizon, stockShare,
            depleted is null, depleted, balance, worst);
    }

    /// <summary>Balance at the end of each year, 0..horizon, in real multiples of
    /// the starting portfolio. Render input only.</summary>
    public double[] PathFor(int startYear, double rate, int horizon, double stockShare)
    {
        var path = new double[horizon + 1];
        Run(startYear, rate, horizon, stockShare, (i, balance) =>
        {
            if (i >= 0 && i <= horizon) path[i] = balance;
        });
        return path;
    }

    /// <summary>The same cohort's own years played backwards, as a path. The
    /// sequence-risk claim is that only the ORDER changes, so the reversed run
    /// has to be built from the identical year rows.</summary>
    public double[] ReversedPathFor(int startYear, double rate, int horizon, double stockShare)
    {
        int start = _years.FindIndex(y => y.Year == startYear);
        if (start < 0 || start + horizon > _years.Count)
            throw new ArgumentOutOfRangeException(nameof(startYear), $"{startYear} has no full {horizon}-year window");

        var window = _years.Skip(start).Take(horizon).Reverse().ToList();
        var path = new double[horizon + 1];
        double balance = 1.0;
        path[0] = balance;
        for (int i = 0; i < horizon; i++)
        {
            balance -= rate;
            if (balance <= 0)
            {
                for (int j = i; j < horizon; j++) path[j + 1] = 0.0;
                return path;
            }
            var y = window[i];
            balance *= 1.0 + (stockShare * y.StockReal + (1 - stockShare) * y.BondReal);
            path[i + 1] = balance;
        }
        return path;
    }

    public IReadOnlyList<RetirementRun> AllCohorts(double rate, int horizon, double stockShare)
    {
        var runs = new List<RetirementRun>();
        for (int i = 0; i + horizon <= _years.Count; i++)
            runs.Add(Run(_years[i].Year, rate, horizon, stockShare));
        return runs;
    }

    public RateResult ByRate(double rate, int horizon, double stockShare)
    {
        var runs = AllCohorts(rate, horizon, stockShare);
        var finals = runs.Select(r => r.FinalRealMultiple).OrderBy(v => v).ToList();
        int failures = runs.Count(r => !r.Survived);

        return new RateResult(rate, horizon, stockShare, runs.Count,
            runs.Count == 0 ? double.NaN : 1.0 - (double)failures / runs.Count,
            failures, Stats.Median(finals), Stats.Percentile(finals, 0.10));
    }

    public MixResult ByMix(double stockShare, double rate, int horizon)
    {
        var r = ByRate(rate, horizon, stockShare);
        return new MixResult(stockShare, rate, horizon, r.SuccessRate, r.MedianFinalMultiple);
    }

    /// <summary>
    /// The highest withdrawal rate at which every single cohort survives. This is
    /// what "safe" actually means in the phrase "safe withdrawal rate", and it is
    /// set by one bad year rather than by the average one.
    /// </summary>
    public double SafeRate(int horizon, double stockShare)
    {
        double lo = 0.01, hi = 0.10;
        for (int i = 0; i < 40; i++)
        {
            double mid = (lo + hi) / 2;
            if (AllCohorts(mid, horizon, stockShare).All(r => r.Survived)) lo = mid; else hi = mid;
        }
        return lo;
    }

    /// <summary>Cohorts ordered by how close they came to running out.</summary>
    public IReadOnlyList<RetirementRun> WorstCohorts(double rate, int horizon, double stockShare, int take) =>
        AllCohorts(rate, horizon, stockShare)
            .OrderBy(r => r.Survived ? 1 : 0)
            .ThenBy(r => r.FinalRealMultiple)
            .Take(take)
            .ToList();

    /// <summary>
    /// The same years in a different order. Sequence risk is usually asserted;
    /// this measures it by reversing each cohort's own returns, which holds the
    /// average and every other moment fixed and changes only the order.
    /// </summary>
    public (double Forward, double Reversed) SequenceTest(int startYear, double rate, int horizon, double stockShare)
    {
        int start = _years.FindIndex(y => y.Year == startYear);
        var window = _years.Skip(start).Take(horizon).ToList();

        double Play(IEnumerable<YearRow> order)
        {
            double balance = 1.0;
            foreach (var y in order)
            {
                balance -= rate;
                if (balance <= 0) return 0;
                balance *= 1.0 + (stockShare * y.StockReal + (1 - stockShare) * y.BondReal);
            }
            return balance;
        }

        return (Play(window), Play(Enumerable.Reverse(window)));
    }

    /// <summary>Every cohort's outcome, for the chart that carries the episode.</summary>
    public IReadOnlyList<object> Timeline(double rate, int horizon, double stockShare) =>
        AllCohorts(rate, horizon, stockShare)
            .Select(r => (object)new
            {
                startYear = r.StartYear,
                survived = r.Survived,
                finalMultiple = Math.Round(r.FinalRealMultiple, 4),
                depletedInYear = r.DepletedInYear,
            })
            .ToList();
}
