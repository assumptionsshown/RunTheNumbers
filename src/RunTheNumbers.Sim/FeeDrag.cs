namespace RunTheNumbers.Sim;

public sealed record FeeResult(
    double AnnualFee,
    int HorizonYears,
    int Starts,
    Percentiles Wealth,
    double MedianWealthNoFee,
    // Share of the final balance that the fee removed.
    double ShareOfFinalLost,
    // Share of the GAIN the fee removed. Always larger, and the more honest
    // framing: the fee is charged on the whole balance but only the gain was
    // ever yours to lose.
    double ShareOfGainLost);

public sealed record FeeYearPoint(int HorizonYears, double ShareOfGainLost, double ShareOfFinalLost);

/// <summary>
/// What an annual percentage fee does to a buy-and-hold position, measured across
/// every start month rather than on a single smooth projection.
/// </summary>
public sealed class FeeDrag(ShillerSeries series)
{
    private readonly IReadOnlyList<Month> _m = series.Months;

    /// <summary>
    /// Real wealth per $1 after holding for <paramref name="months"/>, with the fee
    /// deducted monthly. Real funds accrue their expense ratio continuously, so
    /// monthly deduction is far closer to reality than one annual charge, and it
    /// avoids flattering either side depending on where the charge lands.
    /// </summary>
    private double FinalWealth(int start, int months, double annualFee)
    {
        double monthlyRetention = 1.0 - annualFee / 12.0;
        double units = 1.0 / _m[start].RealTotalReturnPrice;
        double drag = Math.Pow(monthlyRetention, months);
        return units * _m[start + months].RealTotalReturnPrice * drag;
    }

    public FeeResult Run(double annualFee, int horizonYears)
    {
        int months = horizonYears * 12;
        int lastStart = _m.Count - 1 - months;

        var withFee = new List<double>(lastStart + 1);
        var noFee = new List<double>(lastStart + 1);

        for (int start = 0; start <= lastStart; start++)
        {
            withFee.Add(FinalWealth(start, months, annualFee));
            noFee.Add(FinalWealth(start, months, 0));
        }

        var sortedFee = withFee.OrderBy(v => v).ToList();
        var sortedFree = noFee.OrderBy(v => v).ToList();

        double medianFee = Stats.Median(sortedFee);
        double medianFree = Stats.Median(sortedFree);

        return new FeeResult(
            annualFee,
            horizonYears,
            withFee.Count,
            Summarise(sortedFee),
            medianFree,
            1.0 - medianFee / medianFree,
            medianFree > 1.0 ? (medianFree - medianFee) / (medianFree - 1.0) : double.NaN);
    }

    /// <summary>
    /// The same fee measured year by year, so the compounding is visible as a curve
    /// rather than as four separate numbers.
    /// </summary>
    public IReadOnlyList<FeeYearPoint> ByYear(double annualFee, int maxYears)
    {
        var points = new List<FeeYearPoint>();
        for (int y = 1; y <= maxYears; y++)
        {
            var r = Run(annualFee, y);
            points.Add(new FeeYearPoint(y, r.ShareOfGainLost, r.ShareOfFinalLost));
        }
        return points;
    }

    /// <summary>
    /// The worked example most people can picture: what a single starting sum
    /// becomes, and what the fee took, for one long holding period.
    /// </summary>
    public (double NoFee, double WithFee, double Lost) Example(double annualFee, int horizonYears, double amount)
    {
        var r = Run(annualFee, horizonYears);
        double free = r.MedianWealthNoFee * amount;
        double fee = r.Wealth.Median * amount;
        return (free, fee, free - fee);
    }

    private static Percentiles Summarise(List<double> sorted) => new(
        Stats.Percentile(sorted, 0.01),
        Stats.Percentile(sorted, 0.05),
        Stats.Percentile(sorted, 0.25),
        Stats.Median(sorted),
        Stats.Percentile(sorted, 0.75),
        Stats.Percentile(sorted, 0.95),
        Stats.Mean(sorted));
}
