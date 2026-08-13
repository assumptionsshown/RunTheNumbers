using System.Globalization;
using System.Text;

namespace RunTheNumbers.Sim;

public sealed record HousingMetro(long RegionId, int Cbsa, string Name, string State, int SizeRank);

/// <summary>
/// The pinned housing snapshot produced by the Codex data lane (C2/C3/C4 plus
/// the ZHVI supplement). Read only, and only through this loader; the raw
/// vendor files in the same directory are the audit trail, not an input.
/// </summary>
public sealed class HousingPanel
{
    private readonly Dictionary<long, Dictionary<int, double>> _zori = [];
    private readonly Dictionary<long, Dictionary<int, double>> _zhvi = [];
    private readonly Dictionary<int, Dictionary<int, double>> _fhfa = [];
    private readonly List<HousingMetro> _matched = [];

    public IReadOnlyList<HousingMetro> Matched => _matched;

    public static int MonthIndex(string period)
    {
        var p = period.Split('-');
        return int.Parse(p[0], CultureInfo.InvariantCulture) * 12
             + int.Parse(p[1], CultureInfo.InvariantCulture) - 1;
    }

    public static string MonthString(int index) => $"{index / 12:D4}-{index % 12 + 1:D2}";

    private static int QuarterOfMonth(int monthIndex) => (monthIndex / 12) * 4 + (monthIndex % 12) / 3;

    public double Zori(long regionId, int month) => _zori[regionId][month];
    public double Zhvi(long regionId, int month) => _zhvi[regionId][month];
    public double FhfaAtMonth(int cbsa, int month) => _fhfa[cbsa][QuarterOfMonth(month)];

    public static HousingPanel Load(string snapshotDir)
    {
        var panel = new HousingPanel();

        foreach (var line in File.ReadLines(Path.Combine(snapshotDir, "metros.csv")).Skip(1))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var f = SplitCsv(line);
            if (f[7] != "matched") continue;
            panel._matched.Add(new HousingMetro(
                long.Parse(f[0], CultureInfo.InvariantCulture),
                int.Parse(f[4], CultureInfo.InvariantCulture),
                f[2], f[3],
                int.Parse(f[1], CultureInfo.InvariantCulture)));
        }

        LoadSeries(Path.Combine(snapshotDir, "zori-normalised.csv"), panel._zori, "zori_usd_month");
        LoadSeries(Path.Combine(snapshotDir, "zhvi-normalised.csv"), panel._zhvi, "zhvi_usd");

        foreach (var line in File.ReadLines(Path.Combine(snapshotDir, "fhfa-hpi-normalised.csv")).Skip(1))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var f = line.Split(',');
            int cbsa = int.Parse(f[0], CultureInfo.InvariantCulture);
            int year = int.Parse(f[1][..4], CultureInfo.InvariantCulture);
            int q = f[1][4] == 'Q'
                ? int.Parse(f[1][5..], CultureInfo.InvariantCulture)
                : throw new InvalidDataException($"unexpected FHFA period '{f[1]}'");
            var series = panel._fhfa.TryGetValue(cbsa, out var s) ? s : panel._fhfa[cbsa] = [];
            series[year * 4 + q - 1] = double.Parse(f[2], CultureInfo.InvariantCulture);
        }

        return panel;
    }

    private static void LoadSeries(string path, Dictionary<long, Dictionary<int, double>> into, string valueColumn)
    {
        string[] header = File.ReadLines(path).First().Split(',');
        if (Array.IndexOf(header, valueColumn) != 3)
            throw new InvalidDataException($"expected '{valueColumn}' as column 4 of {path}");

        foreach (var line in File.ReadLines(path).Skip(1))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var f = line.Split(',');
            long id = long.Parse(f[0], CultureInfo.InvariantCulture);
            var series = into.TryGetValue(id, out var s) ? s : into[id] = [];
            series[MonthIndex(f[2])] = double.Parse(f[3], CultureInfo.InvariantCulture);
        }
    }

    /// <summary>
    /// Metros with every ZORI and ZHVI month in [start..end] and every FHFA
    /// quarter that window touches, ordered by Zillow size rank. Derived from
    /// the data rather than from a status column, so a coverage regression in a
    /// re-pinned snapshot fails loudly here instead of shrinking a result.
    /// </summary>
    public IReadOnlyList<HousingMetro> CompleteWindow(string startMonth, string endMonth)
    {
        int a = MonthIndex(startMonth), b = MonthIndex(endMonth);
        var complete = new List<HousingMetro>();
        foreach (var m in _matched)
        {
            if (!_zori.TryGetValue(m.RegionId, out var zori)) continue;
            if (!_zhvi.TryGetValue(m.RegionId, out var zhvi)) continue;
            if (!_fhfa.TryGetValue(m.Cbsa, out var fhfa)) continue;

            bool ok = true;
            for (int t = a; t <= b && ok; t++) ok = zori.ContainsKey(t) && zhvi.ContainsKey(t);
            for (int q = QuarterOfMonth(a); q <= QuarterOfMonth(b) && ok; q++) ok = fhfa.ContainsKey(q);
            if (ok) complete.Add(m);
        }
        return complete.OrderBy(m => m.SizeRank).ToList();
    }

    /// <summary>
    /// Which inputs a metro is missing over a window, month by month — null if
    /// none. Exists so a panel-count mismatch names its metros instead of just
    /// throwing a number.
    /// </summary>
    public string? CoverageGaps(HousingMetro m, string startMonth, string endMonth)
    {
        int a = MonthIndex(startMonth), b = MonthIndex(endMonth);
        var parts = new List<string>();

        void Check(string name, Dictionary<long, Dictionary<int, double>> source)
        {
            if (!source.TryGetValue(m.RegionId, out var series)) { parts.Add($"{name} absent"); return; }
            var missing = new List<int>();
            for (int t = a; t <= b; t++) if (!series.ContainsKey(t)) missing.Add(t);
            if (missing.Count > 0)
                parts.Add($"{name} missing {missing.Count} months ({MonthString(missing[0])}..{MonthString(missing[^1])})");
        }

        Check("zori", _zori);
        Check("zhvi", _zhvi);

        if (!_fhfa.TryGetValue(m.Cbsa, out var fhfa)) parts.Add("fhfa absent");
        else
        {
            int miss = 0;
            for (int q = QuarterOfMonth(a); q <= QuarterOfMonth(b); q++) if (!fhfa.ContainsKey(q)) miss++;
            if (miss > 0) parts.Add($"fhfa missing {miss} quarters");
        }

        return parts.Count == 0 ? null : string.Join("; ", parts);
    }

    private static List<string> SplitCsv(string line)
    {
        var fields = new List<string>();
        var sb = new StringBuilder();
        bool quoted = false;
        for (int i = 0; i < line.Length; i++)
        {
            char c = line[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < line.Length && line[i + 1] == '"') { sb.Append('"'); i++; }
                else if (c == '"') quoted = false;
                else sb.Append(c);
            }
            else if (c == '"') quoted = true;
            else if (c == ',') { fields.Add(sb.ToString()); sb.Clear(); }
            else sb.Append(c);
        }
        fields.Add(sb.ToString());
        return fields;
    }
}
