namespace RunTheNumbers.Sim;

/// <summary>When a frightened investor gets back in.</summary>
public abstract record ReentryRule(string Label)
{
    /// <summary>Back in after a fixed spell in cash.</summary>
    public sealed record AfterMonths(int Months) : ReentryRule($"after {Months} months in cash");

    /// <summary>Back in once the market has bounced this far off its low.</summary>
    public sealed record AfterRecovery(double FromTrough)
        : ReentryRule($"after a {FromTrough:P0} bounce off the low");
}

public sealed record PanicResult(
    double DropThreshold,
    string Reentry,
    int MaxPanics,
    int HorizonYears,
    int Starts,
    double MeanPanicsUsed,
    double MedianWealth,
    // Cost against simply holding, as a share of the holder's final balance.
    double MedianCost,
    double P25Cost,
    double P75Cost,
    double WorstCost,
    string WorstStart);

public sealed record BreakEven(
    double AnnualFee,
    double DropThreshold,
    string Reentry,
    int HorizonYears,
    double FeeWealth,
    // Wealth if you pay nothing and panic exactly n times, n = 0,1,2,...
    IReadOnlyList<double> WealthByPanicCount,
    // How many times the market actually triggers this rule in a typical 30 years.
    // Without it, "never breaks even" is unreadable: it matters enormously whether
    // that means "more than 8 panics" or "more than every panic on offer".
    double MeanPanicsAvailable,
    // Fractional number of panics an adviser must prevent for the fee to break
    // even. Null when panicking every single time still beats paying the fee.
    double? PanicsToBreakEven,
    // Wealth does not always fall monotonically with the number of panics: selling
    // into a decline that continues can help. Where it does not, the crossing point
    // is the first one, and it is less stable than it looks.
    bool MonotonicInPanicCount);

/// <summary>
/// What panic selling costs, measured across every start month in the record.
///
/// This exists to price the other side of the fee question. A fee is only a pure
/// loss to an investor who would have held anyway; for one who would have sold at
/// the bottom, the comparison is against the cost of those sales, not against zero.
/// </summary>
public sealed class PanicSell(ShillerSeries series)
{
    private readonly IReadOnlyList<Month> _m = series.Months;

    /// <summary>
    /// Wealth per $1 for someone who sells after a drawdown and returns later, at
    /// most <paramref name="maxPanics"/> times. Zero means never sell, which is
    /// simply holding.
    ///
    /// After getting back in, the reference peak resets to the re-entry price.
    /// Carrying the pre-crash peak forward would trigger an instant re-sale, since
    /// the price is still far below it; a real investor's sense of "the market is
    /// falling" resets to where they bought back in.
    /// </summary>
    private (double Wealth, int PanicsUsed) Simulate(
        int start, int months, double dropThreshold, ReentryRule rule, int maxPanics)
    {
        double startPrice = _m[start].RealTotalReturnPrice;
        double units = 1.0 / startPrice;
        double peak = startPrice;

        bool inCash = false;
        double cash = 0;
        double trough = 0;
        int soldAt = 0;
        int panics = 0;

        int end = start + months;

        for (int t = start + 1; t <= end; t++)
        {
            double price = _m[t].RealTotalReturnPrice;

            if (!inCash)
            {
                peak = Math.Max(peak, price);
                if (panics < maxPanics && price < peak * (1 - dropThreshold))
                {
                    // Sell into cash. Cash holds its real value, the generous
                    // assumption for the panicker, so anything this claims about
                    // the cost of panicking is understated rather than overstated.
                    cash = units * price;
                    units = 0;
                    inCash = true;
                    trough = price;
                    soldAt = t;
                    panics++;
                }
                continue;
            }

            trough = Math.Min(trough, price);
            bool back = rule switch
            {
                ReentryRule.AfterMonths m => t - soldAt >= m.Months,
                ReentryRule.AfterRecovery r => price >= trough * (1 + r.FromTrough),
                _ => throw new NotSupportedException(rule.GetType().Name),
            };

            if (!back) continue;
            units = cash / price;
            cash = 0;
            inCash = false;
            peak = price;
        }

        double wealth = inCash ? cash : units * _m[end].RealTotalReturnPrice;
        return (wealth, panics);
    }

    private double HoldWealth(int start, int months) =>
        _m[start + months].RealTotalReturnPrice / _m[start].RealTotalReturnPrice;

    public PanicResult Run(double dropThreshold, ReentryRule rule, int horizonYears, int maxPanics)
    {
        int months = horizonYears * 12;
        int lastStart = _m.Count - 1 - months;

        var wealth = new List<double>();
        var costs = new List<double>();
        var dates = new List<string>();
        double panicsTotal = 0;

        for (int start = 0; start <= lastStart; start++)
        {
            var (w, used) = Simulate(start, months, dropThreshold, rule, maxPanics);
            double hold = HoldWealth(start, months);

            wealth.Add(w);
            costs.Add(1.0 - w / hold);
            dates.Add(_m[start].Date);
            panicsTotal += used;
        }

        var sortedCost = costs.OrderBy(c => c).ToList();
        int worst = 0;
        for (int i = 1; i < costs.Count; i++) if (costs[i] > costs[worst]) worst = i;

        return new PanicResult(
            dropThreshold, rule.Label, maxPanics, horizonYears, costs.Count,
            panicsTotal / costs.Count,
            Stats.Median(wealth.OrderBy(w => w).ToList()),
            Stats.Median(sortedCost),
            Stats.Percentile(sortedCost, 0.25),
            Stats.Percentile(sortedCost, 0.75),
            costs[worst],
            dates[worst]);
    }

    /// <summary>
    /// The question the fee debate never answers with a number: how many panics
    /// does an adviser have to prevent before their fee has paid for itself?
    ///
    /// Compares paying the fee and never panicking against paying nothing and
    /// panicking n times, on the same start months, then interpolates where the
    /// two lines cross.
    /// </summary>
    public BreakEven FindBreakEven(
        FeeDrag fees, double annualFee, double dropThreshold, ReentryRule rule,
        int horizonYears, int maxPanicsConsidered)
    {
        double feeWealth = fees.Run(annualFee, horizonYears).Wealth.Median;

        var byCount = new List<double>();
        for (int n = 0; n <= maxPanicsConsidered; n++)
        {
            byCount.Add(Run(dropThreshold, rule, horizonYears, n).MedianWealth);
        }

        // How many panics the market actually offers, rather than how many we
        // allowed. These are usually far fewer, and the difference is the whole
        // meaning of "never breaks even".
        double available = Run(dropThreshold, rule, horizonYears, int.MaxValue).MeanPanicsUsed;

        bool monotonic = true;
        for (int n = 1; n < byCount.Count; n++)
        {
            if (byCount[n] > byCount[n - 1] + 1e-9) { monotonic = false; break; }
        }

        // Walk out until panicking n times leaves you worse off than paying the
        // fee, then interpolate between n-1 and n for a fractional answer.
        double? breakEven = null;
        for (int n = 1; n < byCount.Count; n++)
        {
            if (byCount[n] > feeWealth) continue;
            double gap = byCount[n - 1] - byCount[n];
            breakEven = gap <= 0 ? n : (n - 1) + (byCount[n - 1] - feeWealth) / gap;
            break;
        }

        return new BreakEven(annualFee, dropThreshold, rule.Label, horizonYears,
            feeWealth, byCount, available, breakEven, monotonic);
    }
}
