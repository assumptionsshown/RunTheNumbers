using System.Globalization;

namespace RunTheNumbers.Sim;

public sealed record FredMonth(string Month, double? Mortgage30, double? Mortgage15, double? Cpi);

/// <summary>
/// The pinned FRED snapshot produced by the Codex data lane (C1). Read only, and
/// only through this loader: the raw weekly files in the same directory are the
/// audit trail, not an input.
/// </summary>
public sealed class FredHousing
{
    private FredHousing(IReadOnlyList<FredMonth> months) => Months = months;

    public IReadOnlyList<FredMonth> Months { get; }

    public static FredHousing Load(string snapshotDir)
    {
        var path = Path.Combine(snapshotDir, "fred-housing-normalised.csv");
        var lines = File.ReadAllLines(path);
        var header = lines[0].Split(',');

        int Index(string name)
        {
            var i = Array.IndexOf(header, name);
            if (i < 0) throw new InvalidDataException($"column '{name}' missing from {path}");
            return i;
        }

        int month = Index("month");
        int m30 = Index("mortgage30usPercent");
        int m15 = Index("mortgage15usPercent");
        int cpi = Index("cpiaucsl");

        var rows = new List<FredMonth>(lines.Length - 1);
        for (int i = 1; i < lines.Length; i++)
        {
            if (string.IsNullOrWhiteSpace(lines[i])) continue;
            var f = lines[i].Split(',');
            rows.Add(new FredMonth(f[month], Optional(f[m30]), Optional(f[m15]), Optional(f[cpi])));
        }

        // The snapshot guarantees contiguity and the validator checks it, but a
        // hand-edited file would shift every origination date by a month, so the
        // simulation re-checks rather than trusting a document.
        for (int i = 1; i < rows.Count; i++)
        {
            var (py, pm) = Split(rows[i - 1].Month);
            var (cy, cm) = Split(rows[i].Month);
            var expected = pm == 12 ? (py + 1, 1) : (py, pm + 1);
            if ((cy, cm) != expected)
                throw new InvalidDataException($"month sequence breaks at row {i}: {rows[i - 1].Month} -> {rows[i].Month}");
        }

        return new FredHousing(rows);
    }

    private static (int, int) Split(string month)
    {
        var p = month.Split('-');
        return (int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture));
    }

    private static double? Optional(string raw) =>
        double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
}
