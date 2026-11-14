using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace AgentLink;

/// <summary>
/// Renders the per-engine badge tile used on worker rows in the tray menu and
/// the Agent panel — a soft-tinted rounded tile with the engine glyph.
/// </summary>
internal static class EngineBadge
{
    private static readonly Dictionary<string, Geometry> Glyphs = new()
    {
        ["codex"] = Parse("M6,7 L11,12 L6,17 M13,17 L18,17"),
        ["claude"] = Parse("M12,5 L12,19 M5,12 L19,12 M7.5,7.5 L16.5,16.5 M16.5,7.5 L7.5,16.5"),
        ["gemini"] = Parse("M12,4 L20,12 L12,20 L4,12 Z"),
        ["macos"] = Parse("M5,6 L19,6 L19,18 L5,18 Z M5,9.5 L19,9.5"),
        ["agent"] = Parse("M8.5,8.5 L15.5,8.5 L15.5,15.5 L8.5,15.5 Z M5,10.5 L8.5,10.5 M5,13.5 L8.5,13.5 M15.5,10.5 L19,10.5 M15.5,13.5 L19,13.5 M10.5,5 L10.5,8.5 M13.5,5 L13.5,8.5 M10.5,15.5 L10.5,19 M13.5,15.5 L13.5,19"),
    };

    internal static string FamilyOf(string? engine) => engine switch
    {
        { } e when e.Contains("codex") => "codex",
        { } e when e.Contains("claude") => "claude",
        { } e when e.Contains("gemini") => "gemini",
        { } e when e.Contains("macos") => "macos",
        { } e when e.Contains("pi") => "pi",
        _ => "agent",
    };

    internal static FrameworkElement Tile(string? engine, Brush stroke, double size = 26)
    {
        var color = stroke is SolidColorBrush b ? b.Color : Colors.Gray;
        return new Border
        {
            Width = size, Height = size,
            CornerRadius = new CornerRadius(size * 0.27),
            Background = new SolidColorBrush(Color.FromArgb(28, color.R, color.G, color.B)),
            Child = Glyph(engine, stroke, size),
        };
    }

    internal static FrameworkElement Glyph(string? engine, Brush stroke, double size = 26)
    {
        var family = FamilyOf(engine);
        if (family == "pi")
            return new TextBlock
            {
                Text = "π", FontSize = size * 0.5, FontWeight = FontWeights.Bold,
                Foreground = stroke,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
        return new Viewbox
        {
            Width = size * 0.54, Height = size * 0.54,
            Child = new System.Windows.Shapes.Path
            {
                Data = Glyphs[family],
                Stroke = stroke,
                StrokeThickness = 1.7,
                StrokeLineJoin = PenLineJoin.Round,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
            },
        };
    }

    private static Geometry Parse(string data)
    {
        var geometry = Geometry.Parse(data);
        geometry.Freeze();
        return geometry;
    }
}
