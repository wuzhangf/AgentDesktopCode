using System.Windows;
using System.Windows.Media;

namespace AgentLink;

/// <summary>
/// Applies the shared light/dark palette to a window's resources, following
/// the Windows app theme and honouring High Contrast. Both the tray panel and
/// the tray menu keep the same tokens so the product reads as one surface.
/// </summary>
internal static class LinkTheme
{
    internal static void Apply(ResourceDictionary resources)
    {
        using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        var dark = key?.GetValue("AppsUseLightTheme") is 0;
        SetBrush(resources, "LinkSurface", dark ? "#202327" : "#FCFCFD", SystemColors.WindowColor);
        SetBrush(resources, "LinkText", dark ? "#F0F2F5" : "#17202E", SystemColors.WindowTextColor);
        SetBrush(resources, "LinkSecondary", dark ? "#B4BFCC" : "#536071", SystemColors.WindowTextColor);
        SetBrush(resources, "LinkLine", dark ? "#434951" : "#DFE4EB", SystemColors.WindowTextColor);
        SetBrush(resources, "LinkSubtle", dark ? "#2B3036" : "#EDF1F6", SystemColors.ControlColor);
        SetBrush(resources, "LinkHover", dark ? "#383F47" : "#E4EBF4", SystemColors.ControlColor);
        SetBrush(resources, "LinkAccent", dark ? "#83B8FF" : "#0863CD", SystemColors.HighlightColor);
        SetBrush(resources, "LinkOnAccent", dark ? "#102841" : "#FFFFFF", SystemColors.HighlightTextColor);
        SetBrush(resources, "LinkReady", dark ? "#75D7AA" : "#13764E", SystemColors.WindowTextColor);
        SetBrush(resources, "LinkWarn", dark ? "#FF9E8A" : "#B3261E", SystemColors.WindowTextColor);
    }

    private static void SetBrush(ResourceDictionary resources, string key, string color, Color contrastColor)
    {
        var value = SystemParameters.HighContrast ? contrastColor : (Color)ColorConverter.ConvertFromString(color);
        if (resources[key] is SolidColorBrush previous && previous.Color == value) return;
        var brush = new SolidColorBrush(value);
        brush.Freeze();
        resources[key] = brush;
    }
}
