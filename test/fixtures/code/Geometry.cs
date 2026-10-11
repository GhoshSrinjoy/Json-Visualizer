using System.Text;
using static System.Math;

namespace Demo.Geometry;

/// <summary>
/// An immutable 2D point.
/// </summary>
public record Point(double X, double Y)
{
    public double Length => Sqrt(X * X + Y * Y);
}

public record struct Size(int Width, int Height);

public class Canvas : IDisposable
{
    private readonly object _sync = new();
    private readonly List<Point> _points = new();
    private int _version;

    public event EventHandler? Changed;

    public string Title { get; private set; }

    public int Version
    {
        get => _version;
        set { _version = value; Changed?.Invoke(this, EventArgs.Empty); }
    }

    public Canvas(string title)
    {
        this.Title = title;
    }

    /// <summary>Renders the <paramref name="points"/> scaled by a factor.</summary>
    public string Render(IEnumerable<Point> points, int scale)
    {
        var sb = new StringBuilder();
        foreach (var p in points)
        {
            var scaled = Scale(p, scale);
            sb.Append(scaled);
        }
        var labels = points.Select(q => { var text = $"{q.X},{q.Y}"; return text + Title; });
        using (var writer = new StringWriter())
        {
            writer.Write(labels);
        }
        lock (_sync)
        {
            _version++;
        }
        return sb.ToString();
    }

    public static string Describe(object shape)
    {
        switch (shape)
        {
            case Point { X: 0, Y: 0 }:
                return "origin";
            case Point p when p.X > 0:
            case Size:
                return "positive";
            case null:
                throw new ArgumentNullException(nameof(shape));
            default:
                return "other";
        }
    }

    public IEnumerable<Point> Visible(int max)
    {
        var shown = 0;
        foreach (var p in _points)
        {
            if (shown++ >= max) yield break;
            yield return p;
        }
    }

    public static int Clamp(int value, int max)
    {
        while (value > max) value -= max;
        do { value++; } while (value < 0);
        return value;
    }

    private static Point Scale(Point p, int factor) => new(p.X * factor, p.Y * factor);

    public void Dispose() { }
}
