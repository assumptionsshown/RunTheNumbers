using System.Globalization;

namespace RunTheNumbers.Sim;

/// <summary>
/// Which series counts as "the market" when someone says it is at an all-time
/// high. The answer changes the frequency enormously, which is why the episode
/// reports all four rather than picking the flattering one.
/// </summary>
public enum HighBasis
{
    /// <summary>What a headline means: the index level people see quoted.</summary>
    NominalPrice,
    /// <summary>The same index after inflation.</summary>
    RealPrice,
    /// <summary>Price plus reinvested dividends, before inflation.</summary>
    NominalTotalReturn,
    /// <summary>Price plus reinvested dividends, after inflation.</summary>
    RealTotalReturn,
}

public sealed record HighFrequency(
    string Basis, string From, int Months, int Highs, double Share);

public sealed record ForwardReturns(
    string HighBasis,
    string MeasuredOn,
    int HorizonMonths,
    int AfterHighCount,
    double AfterHighMean,
    double AfterHighMedian,
    double AfterHighPositive,
    int AllStartsCount,
    double AllStartsMean,
    double AllStartsMedian,
    double AllStartsPositive)
{
    /// <summary>The comparison the premise lives or dies on.</summary>
    public double MeanGap => AfterHighMean - AllStartsMean;
}

public sealed record TimingResult(
    string Strategy, int Windows, double MedianWealth, double MeanWealth,
    double P5Wealth, double P95Wealth, double MedianVsImmediate);

public sealed record DipWaitResult(
    double DipThreshold, int HorizonYears, int Starts,
    double WaitingWinRate, double MedianCostOfWaiting,
    double NeverArrivedShare, double MedianMonthsWaited);

/// <summary>
/// Episode 3 - what actually happens when you buy at an all-time high, and what
/// the alternatives to buying cost.
/// </summary>
public sealed class AllTimeHighs(ShillerSeries series)
{
    private readonly IReadOnlyList<Month> _m = series.Months;

    private static int Year(string date) =>
        int.Parse(date.AsSpan(0, 4), CultureInfo.InvariantCulture);

    /// <summary>
    /// The level a given definition of "high" is measured on.
    /// </summary>
    /// <remarks>
    /// The nominal price comes from the pinned column and is never reconstructed.
    /// Reconstructing it as RealPrice x Cpi round-trips through two rounded
    /// numbers and lands a few ulps away from the published value, which is
    /// enough to break a tie: 1871-05 and 1872-01 are both exactly 4.86, and the
    /// reconstruction reported the second as a strict new high. Caught by the
    /// independent validator in episodes/ep04-rent-vs-buy/c6-ep03-validation.md.
    ///
    /// The nominal total return has no pinned column, so it still has to be
    /// reconstructed. That is a real asymmetry and it is why the episode's
    /// headline definition is the price index rather than the total return one.
    /// </remarks>
    private double? Level(int i, HighBasis basis) => basis switch
    {
        HighBasis.RealTotalReturn => _m[i].RealTotalReturnPrice,
        HighBasis.NominalTotalReturn => _m[i].Cpi is { } c ? _m[i].RealTotalReturnPrice * c : null,
        HighBasis.RealPrice => _m[i].RealPrice,
        HighBasis.NominalPrice => _m[i].Price,
        _ => null,
    };

    /// <summary>
    /// Months that set a strict new high on the given basis. The first usable
    /// month is never counted, since it has no history to exceed.
    /// </summary>
    private bool[] NewHighs(HighBasis basis)
    {
        var flags = new bool[_m.Count];
        double peak = double.NegativeInfinity;
        bool seeded = false;

        for (int i = 0; i < _m.Count; i++)
        {
            if (Level(i, basis) is not { } v) continue;
            if (!seeded) { peak = v; seeded = true; continue; }
            if (v > peak) { flags[i] = true; peak = v; }
        }
        return flags;
    }

    public HighFrequency Frequency(HighBasis basis, int fromYear)
    {
        var flags = NewHighs(basis);
        int months = 0, highs = 0;
        for (int i = 0; i < _m.Count; i++)
        {
            if (Year(_m[i].Date) < fromYear) continue;
            if (Level(i, basis) is null) continue;
            months++;
            if (flags[i]) highs++;
        }
        return new HighFrequency(basis.ToString(), $"{fromYear}-01", months, highs,
            months == 0 ? double.NaN : (double)highs / months);
    }

    /// <summary>
    /// Forward return from every month that set a new high, against the same
    /// measure taken from every month. Reporting only the first number is how
    /// "returns after highs are good" gets stated without the fact that returns
    /// from any random month are good too.
    /// </summary>
    public ForwardReturns Forward(HighBasis highBasis, bool measureNominal, int horizonMonths, int fromYear)
    {
        var flags = NewHighs(highBasis);
        var afterHigh = new List<double>();
        var allStarts = new List<double>();

        for (int i = 0; i + horizonMonths < _m.Count; i++)
        {
            if (Year(_m[i].Date) < fromYear) continue;

            double? from = measureNominal
                ? (_m[i].Cpi is { } c ? _m[i].RealTotalReturnPrice * c : null)
                : _m[i].RealTotalReturnPrice;
            double? to = measureNominal
                ? (_m[i + horizonMonths].Cpi is { } c2 ? _m[i + horizonMonths].RealTotalReturnPrice * c2 : null)
                : _m[i + horizonMonths].RealTotalReturnPrice;
            if (from is not { } f || to is not { } t || f <= 0) continue;

            double r = t / f - 1.0;
            allStarts.Add(r);
            if (flags[i]) afterHigh.Add(r);
        }

        var hi = afterHigh.OrderBy(v => v).ToList();
        var all = allStarts.OrderBy(v => v).ToList();

        return new ForwardReturns(
            highBasis.ToString(),
            measureNominal ? "nominal total return" : "real total return",
            horizonMonths,
            hi.Count, Stats.Mean(hi), Stats.Median(hi), Share(hi, v => v > 0),
            all.Count, Stats.Mean(all), Stats.Median(all), Share(all, v => v > 0));
    }

    private static double Share(IReadOnlyList<double> values, Func<double, bool> predicate) =>
        values.Count == 0 ? double.NaN : (double)values.Count(predicate) / values.Count;

    // ---------------------------------------------------------------------
    // The saver with impossibly bad luck.
    // ---------------------------------------------------------------------

    /// <summary>
    /// Which month of each calendar year a strategy buys in. Peak and trough are
    /// chosen on the PRICE a buyer would see and pay, while the wealth that
    /// follows is compounded on total return, because dividends arrive whatever
    /// month the purchase happened.
    /// </summary>
    private int BuyMonth(int yearStart, int yearEnd, string strategy)
    {
        if (strategy == "january") return yearStart;

        int best = yearStart;
        for (int i = yearStart; i <= yearEnd; i++)
        {
            double? a = _m[i].RealPrice, b = _m[best].RealPrice;
            if (a is not { } av || b is not { } bv) continue;
            if (strategy == "peak" ? av > bv : av < bv) best = i;
        }
        return best;
    }

    /// <summary>
    /// One unit contributed every calendar year for <paramref name="years"/>
    /// years, measured at the end of the final year, across every rolling window
    /// in the sample. Cash never invested is assumed to hold its real value,
    /// which is the generous assumption for the strategy the episode expects to
    /// lose.
    /// </summary>
    public IReadOnlyList<TimingResult> SaverTiming(int years)
    {
        string[] strategies = ["peak", "january", "trough", "cash"];
        var wealth = strategies.ToDictionary(s => s, _ => new List<double>());

        // Only whole calendar years, so every strategy contributes on the same
        // schedule and no window is decided by a partial year at either end.
        int firstFull = 0;
        while (firstFull < _m.Count && !_m[firstFull].Date.EndsWith("-01", StringComparison.Ordinal)) firstFull++;
        int lastFull = _m.Count - 1;
        while (lastFull >= 0 && !_m[lastFull].Date.EndsWith("-12", StringComparison.Ordinal)) lastFull--;

        for (int start = firstFull; start + years * 12 - 1 <= lastFull; start += 12)
        {
            int end = start + years * 12 - 1;
            double endLevel = _m[end].RealTotalReturnPrice;

            foreach (var s in strategies)
            {
                if (s == "cash") { wealth[s].Add(years); continue; }

                double units = 0;
                bool ok = true;
                for (int y = 0; y < years; y++)
                {
                    int ys = start + y * 12;
                    int buy = BuyMonth(ys, ys + 11, s);
                    double lvl = _m[buy].RealTotalReturnPrice;
                    if (lvl <= 0) { ok = false; break; }
                    units += 1.0 / lvl;
                }
                if (ok) wealth[s].Add(units * endLevel);
            }
        }

        var immediateMedian = Stats.Median(wealth["january"].OrderBy(v => v).ToList());

        return strategies.Select(s =>
        {
            var sorted = wealth[s].OrderBy(v => v).ToList();
            double median = Stats.Median(sorted);
            return new TimingResult(
                s, sorted.Count, median, Stats.Mean(sorted),
                Stats.Percentile(sorted, 0.05), Stats.Percentile(sorted, 0.95),
                immediateMedian > 0 ? median / immediateMedian - 1.0 : double.NaN);
        }).ToList();
    }

    // ---------------------------------------------------------------------
    // The alternative people actually choose: wait for a dip.
    // ---------------------------------------------------------------------

    /// <summary>
    /// Hold cash from the start month until the price falls
    /// <paramref name="dip"/> below its running peak, then invest everything. If
    /// the dip never arrives inside the horizon the money stays in cash for the
    /// whole period, which is the outcome the strategy never plans for.
    /// </summary>
    public DipWaitResult WaitForDip(double dip, int horizonYears)
    {
        int horizon = horizonYears * 12;
        int wins = 0, never = 0, n = 0;
        var costs = new List<double>();
        var waited = new List<double>();

        for (int start = 0; start + horizon < _m.Count; start++)
        {
            if (_m[start].RealPrice is not { } startPrice || startPrice <= 0) continue;
            double endLevel = _m[start + horizon].RealTotalReturnPrice;
            double immediate = endLevel / _m[start].RealTotalReturnPrice;

            double peak = startPrice;
            int bought = -1;
            for (int i = start + 1; i <= start + horizon; i++)
            {
                if (_m[i].RealPrice is not { } p) continue;
                if (p > peak) peak = p;
                if (p <= peak * (1.0 - dip)) { bought = i; break; }
            }

            // Cash holds its real value, so never investing ends with exactly
            // what went in.
            double waiting = bought < 0 ? 1.0 : endLevel / _m[bought].RealTotalReturnPrice;

            n++;
            if (bought < 0) never++; else waited.Add(bought - start);
            if (waiting >= immediate) wins++;
            costs.Add(waiting / immediate - 1.0);
        }

        var sortedCosts = costs.OrderBy(v => v).ToList();
        var sortedWait = waited.OrderBy(v => v).ToList();

        return new DipWaitResult(
            dip, horizonYears, n,
            n == 0 ? double.NaN : (double)wins / n,
            Stats.Median(sortedCosts),
            n == 0 ? double.NaN : (double)never / n,
            Stats.Median(sortedWait));
    }

    /// <summary>
    /// Forward real total return from a new high, split by starting valuation,
    /// so the episode can answer "but this high is expensive" with deciles
    /// rather than with a shrug.
    /// </summary>
    public IReadOnlyList<object> AfterHighByCape(HighBasis basis, int horizonMonths)
    {
        var flags = NewHighs(basis);
        var rows = new List<(double Cape, double Return)>();

        for (int i = 0; i + horizonMonths < _m.Count; i++)
        {
            if (!flags[i] || _m[i].Cape is not { } cape) continue;
            double r = _m[i + horizonMonths].RealTotalReturnPrice / _m[i].RealTotalReturnPrice - 1.0;
            rows.Add((cape, r));
        }

        var ordered = rows.OrderBy(r => r.Cape).ToList();
        int buckets = 5;
        var result = new List<object>();
        for (int b = 0; b < buckets; b++)
        {
            int lo = b * ordered.Count / buckets;
            int hi = (b + 1) * ordered.Count / buckets;
            var slice = ordered.GetRange(lo, hi - lo);
            if (slice.Count == 0) continue;
            var returns = slice.Select(s => s.Return).OrderBy(v => v).ToList();
            result.Add(new
            {
                bucket = b + 1,
                capeLow = slice[0].Cape,
                capeHigh = slice[^1].Cape,
                starts = slice.Count,
                mean = Stats.Mean(returns),
                median = Stats.Median(returns),
                positive = Share(returns, v => v > 0),
            });
        }
        return result;
    }
}
