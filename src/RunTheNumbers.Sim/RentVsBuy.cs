namespace RunTheNumbers.Sim;

/// <summary>One assumption bundle from the C5 memo, named so results carry it.</summary>
public sealed record RvbAssumptions(
    string Name,
    double PropertyTax, double Insurance, double Maintenance,
    double BuyCost, double SellCost, double Down)
{
    public static readonly RvbAssumptions Base =
        new("base", 0.010, 0.005, 0.010, 0.025, 0.07, 0.20);
    public static readonly RvbAssumptions LowOwnerCost =
        new("low-owner-cost", 0.005, 0.0025, 0.010, 0.02, 0.05, 0.20);
    public static readonly RvbAssumptions HighOwnerCost =
        new("high-owner-cost", 0.019, 0.010, 0.020, 0.05, 0.10, 0.20);
    public static readonly RvbAssumptions OldHomeStress =
        Base with { Name = "old-home-stress", Maintenance = 0.04 };
}

public sealed record RvbRun(
    long RegionId, int StartMonth, int HoldMonths, double RatePercent,
    double StartPrice, double StartRentYield, double GapShare, bool BuyWon);

/// <summary>
/// Rent versus buy on the matched metro panel. Both households spend exactly
/// the same cash every month: whoever pays less that month invests the surplus
/// in equities, so the verdict compares wealth, never lifestyle.
/// </summary>
public sealed class RentVsBuy
{
    private readonly HousingPanel _panel;
    private readonly Dictionary<int, double> _rate = [];      // month -> 30y percent
    private readonly Dictionary<int, double> _equity = [];    // month -> nominal TR index

    public RentVsBuy(HousingPanel panel, FredHousing fred, ShillerSeries shiller)
    {
        _panel = panel;
        foreach (var m in fred.Months)
            if (m.Mortgage30 is { } r) _rate[HousingPanel.MonthIndex(m.Month)] = r;
        foreach (var s in shiller.Months)
            if (s.Cpi is { } cpi)
                _equity[HousingPanel.MonthIndex(s.Date)] = s.RealTotalReturnPrice * cpi;
    }

    private double Growth(int monthFrom) => _equity[monthFrom + 1] / _equity[monthFrom];

    /// <summary>
    /// One household pair in one metro. <paramref name="fhfaPath"/> swaps the
    /// home-value path (never the starting level) for the FHFA quarterly index,
    /// stepped at quarter boundaries — the pre-registered sensitivity from
    /// episodes/ep04-rent-vs-buy/model-choice.md.
    /// </summary>
    public RvbRun Run(HousingMetro metro, int t0, int holdMonths, RvbAssumptions a, bool fhfaPath = false)
    {
        double p0 = _panel.Zhvi(metro.RegionId, t0);
        double fhfa0 = fhfaPath ? _panel.FhfaAtMonth(metro.Cbsa, t0) : 1;
        double HomeValue(int t) => fhfaPath
            ? p0 * _panel.FhfaAtMonth(metro.Cbsa, t) / fhfa0
            : _panel.Zhvi(metro.RegionId, t);

        double ratePercent = _rate[t0];
        double r = ratePercent / 100.0 / 12.0;
        double loan = p0 * (1 - a.Down);
        double payment = loan * r / (1 - Math.Pow(1 + r, -360));

        // The renter starts with everything the buyer sank at closing.
        double renter = p0 * a.Down + p0 * a.BuyCost;
        double sidecar = 0;                    // the buyer's surplus, when owning is cheaper
        double balance = loan;

        for (int m = 1; m <= holdMonths; m++)
        {
            double g = Growth(t0 + m - 1);
            renter *= g;
            sidecar *= g;

            double ownerOut = payment
                + (a.PropertyTax + a.Insurance + a.Maintenance) / 12.0 * HomeValue(t0 + m);
            double rent = _panel.Zori(metro.RegionId, t0 + m);

            double diff = ownerOut - rent;
            if (diff >= 0) renter += diff; else sidecar -= diff;

            balance = balance * (1 + r) - payment;
        }

        double proceeds = HomeValue(t0 + holdMonths) * (1 - a.SellCost) - balance;
        double buyer = proceeds + sidecar;
        double gap = (buyer - renter) / p0;

        return new RvbRun(
            metro.RegionId, t0, holdMonths, ratePercent,
            p0, 12.0 * _panel.Zori(metro.RegionId, t0) / p0,
            gap, gap > 0);
    }

    public List<RvbRun> AllRuns(
        IReadOnlyList<HousingMetro> metros, int windowStart, int windowEnd,
        int holdYears, RvbAssumptions a, bool fhfaPath = false)
    {
        int hold = holdYears * 12;
        var runs = new List<RvbRun>();
        for (int t0 = windowStart; t0 + hold <= windowEnd; t0++)
            foreach (var m in metros)
                runs.Add(Run(m, t0, hold, a, fhfaPath));
        return runs;
    }

    /// <summary>
    /// The no-data half: the annual rent yield (first year's rent over price) at
    /// which buying exactly ties renting, under steady growth everywhere. Solved
    /// numerically on the same ledger as the historical runs, so the arithmetic
    /// and the history cannot drift apart.
    /// </summary>
    public static double BreakEvenRentYield(
        double ratePercent, int holdYears, RvbAssumptions a,
        double homeGrowthAnnual, double marketReturnAnnual, double rentGrowthAnnual)
    {
        double lo = 0.001, hi = 0.30;
        for (int i = 0; i < 60; i++)
        {
            double mid = (lo + hi) / 2;
            if (SteadyGap(ratePercent, holdYears, a, homeGrowthAnnual, marketReturnAnnual, rentGrowthAnnual, mid) > 0)
                hi = mid;   // buying already wins: the tie sits at a lower yield
            else
                lo = mid;
        }
        return (lo + hi) / 2;
    }

    private static double SteadyGap(
        double ratePercent, int holdYears, RvbAssumptions a,
        double homeG, double marketR, double rentG, double rentYield)
    {
        double p0 = 1.0;
        double gHome = Math.Pow(1 + homeG, 1 / 12.0);
        double gMarket = Math.Pow(1 + marketR, 1 / 12.0);
        double gRent = Math.Pow(1 + rentG, 1 / 12.0);

        double r = ratePercent / 100.0 / 12.0;
        double loan = p0 * (1 - a.Down);
        double payment = loan * r / (1 - Math.Pow(1 + r, -360));

        double renter = p0 * (a.Down + a.BuyCost);
        double sidecar = 0;
        double balance = loan;
        int hold = holdYears * 12;

        for (int m = 1; m <= hold; m++)
        {
            renter *= gMarket;
            sidecar *= gMarket;
            double home = p0 * Math.Pow(gHome, m);
            double ownerOut = payment + (a.PropertyTax + a.Insurance + a.Maintenance) / 12.0 * home;
            double rent = rentYield / 12.0 * p0 * Math.Pow(gRent, m - 1);
            double diff = ownerOut - rent;
            if (diff >= 0) renter += diff; else sidecar -= diff;
            balance = balance * (1 + r) - payment;
        }

        double buyer = p0 * Math.Pow(gHome, hold) * (1 - a.SellCost) - balance + sidecar;
        return buyer - renter;
    }
}
