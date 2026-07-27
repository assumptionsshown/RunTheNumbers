namespace RunTheNumbers.Sim;

/// <summary>How the money still waiting to be deployed is treated.</summary>
public enum CashPolicy
{
    /// <summary>
    /// Cash keeps its purchasing power (0% real). Deliberately the generous
    /// assumption for DCA, and a fair long-run stand-in for T-bills.
    /// </summary>
    HoldsRealValue,

    /// <summary>
    /// Cash earns 0% nominal, so it decays with inflation. The mattress case.
    /// </summary>
    ZeroNominal,
}

public sealed record WindowResult(
    int Months,
    int Starts,
    double LumpSumWinRate,
    double GapMean,
    double GapP5,
    double GapP25,
    double GapMedian,
    double GapP75,
    double GapP95,
    double GapMin,
    string GapMinDate,
    double GapMax,
    string GapMaxDate,
    double DcaWinAverageGain,
    double DcaLossAverageCost);

public sealed record HorizonResult(
    int Months,
    int HorizonYears,
    int Starts,
    Percentiles LumpSum,
    Percentiles Dca);

public sealed record Percentiles(
    double P1, double P5, double P25, double Median, double P75, double P95, double Mean);

public sealed record CapeBucket(
    int Decile, double CapeLow, double CapeHigh, int Starts, double DcaWinRate, double GapMedian);

public sealed record HistogramBin(double Low, double High, int Count);

/// <summary>One month along a single start date's story, used to animate the
/// two strategies diverging instead of only reporting where they ended.</summary>
public sealed record PathPoint(
    string Date, int MonthIndex, bool StillBuying, double LumpSum, double Dca, double Price);

public sealed record Pathway(
    string StartDate, int WindowMonths, int HorizonYears, string Note,
    IReadOnlyList<PathPoint> Points);

public sealed record WorstStart(
    string Date, double LumpSumMultiple, double DcaMultiple, double Gap, double? StartingCape);

public sealed class LumpSumVsDca(ShillerSeries series, CashPolicy cashPolicy)
{
    private readonly IReadOnlyList<Month> _m = series.Months;

    /// <summary>
    /// Units of the real total-return index bought per $1 deployed as a lump sum
    /// at <paramref name="start"/>.
    /// </summary>
    private double LumpSumUnits(int start) => 1.0 / _m[start].RealTotalReturnPrice;

    /// <summary>
    /// Units bought per $1 spread evenly over <paramref name="months"/> monthly
    /// purchases beginning at <paramref name="start"/>.
    /// </summary>
    private double DcaUnits(int start, int months)
    {
        double units = 0;
        double slice = 1.0 / months;
        for (int k = 0; k < months; k++)
        {
            var m = _m[start + k];
            double realValue = slice;
            if (cashPolicy == CashPolicy.ZeroNominal)
            {
                // Nominal dollars sat idle; discount them by realised inflation.
                var cpi0 = _m[start].Cpi;
                var cpiK = m.Cpi;
                if (cpi0 is null || cpiK is null)
                    throw new InvalidOperationException($"CPI missing near {m.Date}");
                realValue *= cpi0.Value / cpiK.Value;
            }
            units += realValue / m.RealTotalReturnPrice;
        }
        return units;
    }

    /// <summary>
    /// Once both portfolios are fully deployed they hold the same asset, so the
    /// relative outcome is already locked in when the last purchase is made.
    /// This ratio is therefore independent of how long the money is then held.
    /// </summary>
    private double Ratio(int start, int months) => DcaUnits(start, months) / LumpSumUnits(start);

    public WindowResult Window(int months)
    {
        var gaps = new List<double>();
        var dates = new List<string>();

        // The final purchase lands on start + months - 1, so the last usable
        // start is Count - months.
        int lastStart = _m.Count - months;
        for (int start = 0; start <= lastStart; start++)
        {
            gaps.Add(Ratio(start, months) - 1.0);
            dates.Add(_m[start].Date);
        }

        var sorted = gaps.OrderBy(g => g).ToList();
        int lumpSumWins = gaps.Count(g => g < 0);

        int minIdx = 0, maxIdx = 0;
        for (int i = 1; i < gaps.Count; i++)
        {
            if (gaps[i] < gaps[minIdx]) minIdx = i;
            if (gaps[i] > gaps[maxIdx]) maxIdx = i;
        }

        var dcaWins = gaps.Where(g => g > 0).ToList();
        var dcaLosses = gaps.Where(g => g <= 0).ToList();

        return new WindowResult(
            months,
            gaps.Count,
            (double)lumpSumWins / gaps.Count,
            Stats.Mean(gaps),
            Stats.Percentile(sorted, 0.05),
            Stats.Percentile(sorted, 0.25),
            Stats.Median(sorted),
            Stats.Percentile(sorted, 0.75),
            Stats.Percentile(sorted, 0.95),
            gaps[minIdx], dates[minIdx],
            gaps[maxIdx], dates[maxIdx],
            dcaWins.Count > 0 ? Stats.Mean(dcaWins) : double.NaN,
            dcaLosses.Count > 0 ? Stats.Mean(dcaLosses) : double.NaN);
    }

    public HorizonResult Horizon(int months, int horizonYears)
    {
        int hold = horizonYears * 12;
        // Deployment finishes on the month of the final purchase; the holding
        // period is measured from there, so the last month touched is
        // start + (months - 1) + hold.
        int lastStart = _m.Count - 1 - (months - 1) - hold;

        var ls = new List<double>();
        var dca = new List<double>();

        for (int start = 0; start <= lastStart; start++)
        {
            int end = start + (months - 1) + hold;
            double endPrice = _m[end].RealTotalReturnPrice;
            ls.Add(LumpSumUnits(start) * endPrice);
            dca.Add(DcaUnits(start, months) * endPrice);
        }

        return new HorizonResult(months, horizonYears, ls.Count, Summarise(ls), Summarise(dca));
    }

    private static Percentiles Summarise(List<double> values)
    {
        var sorted = values.OrderBy(v => v).ToList();
        return new Percentiles(
            Stats.Percentile(sorted, 0.01),
            Stats.Percentile(sorted, 0.05),
            Stats.Percentile(sorted, 0.25),
            Stats.Median(sorted),
            Stats.Percentile(sorted, 0.75),
            Stats.Percentile(sorted, 0.95),
            Stats.Mean(values));
    }

    /// <summary>
    /// Every start month's gap in chronological order, so the histogram can be
    /// animated filling up as history runs rather than simply appearing.
    /// </summary>
    public (string FirstDate, double[] Gaps) GapSeries(int months)
    {
        int lastStart = _m.Count - months;
        var gaps = new double[lastStart + 1];
        for (int start = 0; start <= lastStart; start++) gaps[start] = Ratio(start, months) - 1.0;
        return (_m[0].Date, gaps);
    }

    /// <summary>
    /// The full shape of the DCA-minus-lump-sum outcome, binned. The percentiles
    /// hide what matters most here: a dense cluster of small DCA shortfalls and a
    /// thin, very long right tail from the handful of crash windows.
    /// </summary>
    public IReadOnlyList<HistogramBin> GapHistogram(int months, double binWidth)
    {
        int lastStart = _m.Count - months;
        var gaps = new List<double>();
        for (int start = 0; start <= lastStart; start++) gaps.Add(Ratio(start, months) - 1.0);

        int Bin(double g) => (int)Math.Floor(g / binWidth);
        int lo = gaps.Min(Bin);
        int hi = gaps.Max(Bin);

        var counts = new int[hi - lo + 1];
        foreach (var g in gaps) counts[Bin(g) - lo]++;

        return counts
            .Select((c, i) => new HistogramBin((lo + i) * binWidth, (lo + i + 1) * binWidth, c))
            .ToList();
    }

    /// <summary>
    /// Does an expensive market change the answer? Buckets every start month by
    /// its starting CAPE and reports how often DCA came out ahead.
    /// </summary>
    public IReadOnlyList<CapeBucket> ByCapeDecile(int months)
    {
        int lastStart = _m.Count - months;
        var points = new List<(double Cape, double Gap)>();
        for (int start = 0; start <= lastStart; start++)
        {
            if (_m[start].Cape is not { } cape) continue;
            points.Add((cape, Ratio(start, months) - 1.0));
        }

        var ordered = points.OrderBy(p => p.Cape).ToList();
        var buckets = new List<CapeBucket>();
        int size = ordered.Count / 10;

        for (int d = 0; d < 10; d++)
        {
            int from = d * size;
            int to = d == 9 ? ordered.Count : from + size;
            var slice = ordered.GetRange(from, to - from);
            var gaps = slice.Select(s => s.Gap).OrderBy(g => g).ToList();
            buckets.Add(new CapeBucket(
                d + 1,
                slice[0].Cape,
                slice[^1].Cape,
                slice.Count,
                (double)slice.Count(s => s.Gap > 0) / slice.Count,
                Stats.Median(gaps)));
        }

        return buckets;
    }

    /// <summary>The start months where going all-in hurt the most, and what
    /// spreading the purchases actually saved on each.</summary>
    public IReadOnlyList<WorstStart> WorstLumpSumStarts(int months, int horizonYears, int take)
    {
        int hold = horizonYears * 12;
        int lastStart = _m.Count - 1 - (months - 1) - hold;

        var rows = new List<WorstStart>();
        for (int start = 0; start <= lastStart; start++)
        {
            int end = start + (months - 1) + hold;
            double endPrice = _m[end].RealTotalReturnPrice;
            double lsValue = LumpSumUnits(start) * endPrice;
            double dcaValue = DcaUnits(start, months) * endPrice;
            rows.Add(new WorstStart(
                _m[start].Date, lsValue, dcaValue, dcaValue / lsValue - 1.0, _m[start].Cape));
        }

        return rows.OrderBy(r => r.LumpSumMultiple).Take(take).ToList();
    }

    /// <summary>
    /// The month-by-month value of both strategies from a single start date.
    /// While the drip is still buying, its portfolio is part shares and part
    /// cash, which is exactly the period where the two paths separate.
    /// </summary>
    public Pathway Path(string startDate, int months, int horizonYears, string note)
    {
        int start = -1;
        for (int i = 0; i < _m.Count; i++)
        {
            if (_m[i].Date == startDate) { start = i; break; }
        }
        if (start < 0) throw new ArgumentException($"start month {startDate} not in series");

        int end = Math.Min(start + (months - 1) + horizonYears * 12, _m.Count - 1);
        double lsUnits = LumpSumUnits(start);
        double slice = 1.0 / months;

        var points = new List<PathPoint>();
        double dcaUnits = 0;

        for (int t = start; t <= end; t++)
        {
            int k = t - start;

            // Each contribution buys at that month's price, so units accumulate
            // as the window progresses.
            if (k < months)
            {
                double realValue = slice;
                if (cashPolicy == CashPolicy.ZeroNominal)
                {
                    var cpi0 = _m[start].Cpi;
                    var cpiK = _m[t].Cpi;
                    if (cpi0 is not null && cpiK is not null) realValue *= cpi0.Value / cpiK.Value;
                }
                dcaUnits += realValue / _m[t].RealTotalReturnPrice;
            }

            double price = _m[t].RealTotalReturnPrice;
            double cashLeft = k < months ? slice * (months - 1 - k) : 0;

            points.Add(new PathPoint(
                _m[t].Date,
                k,
                k < months,
                lsUnits * price,
                dcaUnits * price + cashLeft,
                price / _m[start].RealTotalReturnPrice));
        }

        return new Pathway(startDate, months, horizonYears, note, points);
    }

    /// <summary>
    /// Guards the claim that the winner is decided during deployment: the DCA/LS
    /// ratio must not drift as the holding period lengthens.
    /// </summary>
    public double MaxRatioDriftAcrossHorizons(int months, IReadOnlyList<int> horizonYears)
    {
        double worst = 0;
        int maxHold = horizonYears.Max() * 12;
        int lastStart = _m.Count - 1 - (months - 1) - maxHold;

        for (int start = 0; start <= lastStart; start++)
        {
            double reference = Ratio(start, months);
            foreach (var h in horizonYears)
            {
                int end = start + (months - 1) + h * 12;
                double endPrice = _m[end].RealTotalReturnPrice;
                double realised = (DcaUnits(start, months) * endPrice) / (LumpSumUnits(start) * endPrice);
                worst = Math.Max(worst, Math.Abs(realised - reference));
            }
        }

        return worst;
    }
}
