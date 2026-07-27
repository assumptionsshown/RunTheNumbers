using System.Globalization;

namespace RunTheNumbers.Sim;

/// <summary>
/// One month of Shiller's dataset. Everything the simulations need is already
/// inflation-adjusted, so no episode has to re-derive real returns.
/// </summary>
public sealed record Month(
    string Date,
    double RealTotalReturnPrice,
    double? Cpi,
    double? Cape,
    double? RealPrice);

public sealed class ShillerSeries
{
    private ShillerSeries(IReadOnlyList<Month> months) => Months = months;

    public IReadOnlyList<Month> Months { get; }

    public int Count => Months.Count;

    public static ShillerSeries Load(string csvPath)
    {
        var lines = File.ReadAllLines(csvPath);
        if (lines.Length < 2) throw new InvalidDataException($"{csvPath} has no data rows");

        var header = lines[0].Split(',');
        int Index(string name)
        {
            var i = Array.IndexOf(header, name);
            if (i < 0) throw new InvalidDataException($"column '{name}' missing from {csvPath}");
            return i;
        }

        int date = Index("date");
        int realTr = Index("realTotalReturnPrice");
        int cpi = Index("cpi");
        int cape = Index("cape");
        int realPrice = Index("realPrice");

        var months = new List<Month>(lines.Length - 1);
        for (int i = 1; i < lines.Length; i++)
        {
            var f = lines[i].Split(',');
            months.Add(new Month(
                f[date],
                Required(f[realTr], "realTotalReturnPrice", i),
                Optional(f[cpi]),
                Optional(f[cape]),
                Optional(f[realPrice])));
        }

        // The snapshot builder already guarantees a contiguous monthly series,
        // but re-check here so a hand-edited CSV cannot silently shift every
        // start date by a month.
        for (int i = 1; i < months.Count; i++)
        {
            var (py, pm) = Split(months[i - 1].Date);
            var (cy, cm) = Split(months[i].Date);
            var expected = pm == 12 ? (py + 1, 1) : (py, pm + 1);
            if ((cy, cm) != expected)
                throw new InvalidDataException(
                    $"month sequence breaks at row {i}: {months[i - 1].Date} -> {months[i].Date}");
        }

        return new ShillerSeries(months);
    }

    private static (int Year, int Month) Split(string date)
    {
        var parts = date.Split('-');
        return (int.Parse(parts[0], CultureInfo.InvariantCulture),
                int.Parse(parts[1], CultureInfo.InvariantCulture));
    }

    private static double Required(string raw, string column, int row)
    {
        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v))
            throw new InvalidDataException($"row {row}: '{column}' is not a number ('{raw}')");
        return v;
    }

    private static double? Optional(string raw) =>
        double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
}
