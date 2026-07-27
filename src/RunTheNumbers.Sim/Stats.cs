namespace RunTheNumbers.Sim;

public static class Stats
{
    /// <summary>
    /// Linear-interpolated percentile. <paramref name="sorted"/> must already be
    /// in ascending order.
    /// </summary>
    public static double Percentile(IReadOnlyList<double> sorted, double p)
    {
        if (sorted.Count == 0) return double.NaN;
        if (sorted.Count == 1) return sorted[0];

        var rank = p * (sorted.Count - 1);
        var lo = (int)Math.Floor(rank);
        var hi = (int)Math.Ceiling(rank);
        if (lo == hi) return sorted[lo];
        return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
    }

    public static double Median(IReadOnlyList<double> sorted) => Percentile(sorted, 0.5);

    public static double Mean(IReadOnlyList<double> values)
    {
        if (values.Count == 0) return double.NaN;
        double sum = 0;
        foreach (var v in values) sum += v;
        return sum / values.Count;
    }
}
