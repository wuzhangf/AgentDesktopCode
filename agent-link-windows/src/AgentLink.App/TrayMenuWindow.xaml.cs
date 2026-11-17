using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace AgentLink;

/// <summary>
/// WPF tray popup rendered from <see cref="TrayMenuModel"/> entries — same
/// surface, palette and dismissal semantics as <see cref="LinkWindow"/> so the
/// product reads as one piece. Submenus drill into the same surface (header
/// row + back button), matching how lightweight tray panels behave.
/// </summary>
public partial class TrayMenuWindow : Window
{
    private static readonly Dictionary<string, Geometry> Icons = new()
    {
        ["phone"] = Parse("M8,3 L16,3 L16,21 L8,21 Z M10.5,18.5 L13.5,18.5"),
        ["phoneOn"] = Parse("M8,3 L16,3 L16,21 L8,21 Z M10.5,18.5 L13.5,18.5"),
        ["agent"] = Parse("M8.5,8.5 L15.5,8.5 L15.5,15.5 L8.5,15.5 Z M5,10.5 L8.5,10.5 M5,13.5 L8.5,13.5 M15.5,10.5 L19,10.5 M15.5,13.5 L19,13.5 M10.5,5 L10.5,8.5 M13.5,5 L13.5,8.5 M10.5,15.5 L10.5,19 M13.5,15.5 L13.5,19"),
        ["agentOn"] = Parse("M8.5,8.5 L15.5,8.5 L15.5,15.5 L8.5,15.5 Z M5,10.5 L8.5,10.5 M5,13.5 L8.5,13.5 M15.5,10.5 L19,10.5 M15.5,13.5 L19,13.5 M10.5,5 L10.5,8.5 M13.5,5 L13.5,8.5 M10.5,15.5 L10.5,19 M13.5,15.5 L13.5,19"),
        ["member"] = Parse("M12,11.5 A3.5,3.5 0 1 1 12,4.5 A3.5,3.5 0 1 1 12,11.5 Z M5.5,19.5 C5.5,15.5 18.5,15.5 18.5,19.5"),
        ["pair"] = Parse("M10,8 L8,8 A4,4 0 0 0 8,16 L10,16 M14,8 L16,8 A4,4 0 0 1 16,16 L14,16 M8,12 L16,12"),
        ["check"] = Parse("M5,12.5 L10,17.5 L19,7"),
        ["reject"] = Parse("M7,7 L17,17 M17,7 L7,17"),
        ["warn"] = Parse("M12,4 L21,20 L3,20 Z M12,10 L12,14.5 M12,17 L12,17.2"),
        ["refresh"] = Parse("M19,9 A7.5,7.5 0 1 0 19.8,14 M19,4 L19,9 L14,9"),
        ["settings"] = Parse("M12,9 A3,3 0 1 1 12,15 A3,3 0 1 1 12,9 Z M12,3 L12,6 M12,18 L12,21 M3,12 L6,12 M18,12 L21,12 M5.6,5.6 L7.7,7.7 M16.3,16.3 L18.4,18.4 M18.4,5.6 L16.3,7.7 M7.7,16.3 L5.6,18.4"),
        ["exit"] = Parse("M9,4 L4,4 L4,20 L9,20 M13,12 L21,12 M17,8 L21,12 L17,16"),
        ["open"] = Parse("M4,4 L20,4 L20,20 L4,20 Z M9,4 L9,20"),
        ["invite"] = Parse("M12,5 L12,19 M5,12 L19,12"),
        ["copy"] = Parse("M9,9 L20,9 L20,20 L9,20 Z M4,15 L4,4 L15,4"),
        ["card"] = Parse("M4,6 L20,6 L20,18 L4,18 Z M4,10 L20,10"),
        ["back"] = Parse("M15,5 L8,12 L15,19"),
        ["next"] = Parse("M9,5 L16,12 L9,19"),
    };

    private static readonly HashSet<string?> ClosesBefore =
        ["open", "openMain", "openAgents", "openSettings", "inviteQr", "inviteCopy", "workerPick", "exit"];

    private readonly Func<TrayMenuEntry, Task> dispatch;
    private readonly DispatcherTimer dismiss = new() { Interval = TimeSpan.FromMilliseconds(160) };
    private readonly List<(string Title, IReadOnlyList<TrayMenuEntry> Items)> navigation = [];
    private IReadOnlyList<TrayMenuEntry> configuration = [];
    private IReadOnlyList<TrayMenuEntry> usage = TrayMenuModel.BuildUsage(null);
    private bool dispatching;

    internal TrayMenuWindow(IReadOnlyList<TrayMenuEntry> entries, Func<TrayMenuEntry, Task> dispatch)
    {
        InitializeComponent();
        this.dispatch = dispatch;
        LinkTheme.Apply(Resources);
        ConfigTab.Checked += (_, _) => SelectPage();
        UsageTab.Checked += async (_, _) =>
        {
            SelectPage();
            await ReadUsageAsync();
        };
        UsageRange.SelectionChanged += async (_, _) =>
        {
            if (UsageTab.IsChecked == true) await ReadUsageAsync();
        };
        Closing += (_, e) => { e.Cancel = true; Hide(); };
        Deactivated += (_, _) => dismiss.Start();
        Activated += (_, _) => { dismiss.Stop(); LinkTheme.Apply(Resources); };
        dismiss.Tick += (_, _) =>
        {
            dismiss.Stop();
            if (!IsActive) Hide();
        };
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) { e.Handled = true; GoBack(); }
        };
        configuration = entries;
        ConfigTab.IsChecked = true;
    }

    internal void OpenRoot()
    {
        ConfigTab.IsChecked = true;
        SelectPage();
    }

    internal void ShowConfiguration(IReadOnlyList<TrayMenuEntry> entries, bool resetNavigation = false)
    {
        configuration = entries;
        if (resetNavigation) navigation.Clear();
        if (ConfigTab.IsChecked == true && navigation.Count == 0) RenderActive();
    }

    internal void ShowUsage(UsageSnapshot? snapshot, string? range)
    {
        if (range != SelectedUsageRange) return;
        usage = TrayMenuModel.BuildUsage(snapshot);
        if (UsageTab.IsChecked == true) RenderActive();
    }

    private string SelectedUsageRange => UsageRange.SelectedIndex == 1 ? "7" : "1";

    private async Task ReadUsageAsync()
    {
        ShowUsage(null, SelectedUsageRange);
        await dispatch(new(TrayMenuEntryKind.Item, "", Action: "usage", Id: SelectedUsageRange));
    }

    internal void SetFeedback(string? message)
    {
        Feedback.Text = message;
        Feedback.Visibility = string.IsNullOrEmpty(message) ? Visibility.Collapsed : Visibility.Visible;
    }

    private void SelectPage()
    {
        navigation.Clear();
        SetFeedback(null);
        UsageCaption.Visibility = UsageTab.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
        RenderActive();
    }

    private void RenderActive()
    {
        if (navigation.Count > 0) Render(navigation[^1].Items, navigation[^1].Title);
        else Render(UsageTab.IsChecked == true ? usage : configuration, null);
    }

    private async void Main_Click(object sender, RoutedEventArgs e) =>
        await DispatchAsync(new(TrayMenuEntryKind.Item, "", Action: "openMain"));

    private async void Refresh_Click(object sender, RoutedEventArgs e)
    {
        if (UsageTab.IsChecked == true) await ReadUsageAsync();
        else await DispatchAsync(new(TrayMenuEntryKind.Item, "", Action: "refresh"));
    }

    private async void Exit_Click(object sender, RoutedEventArgs e) =>
        await DispatchAsync(new(TrayMenuEntryKind.Item, "", Action: "exit"));

    private void GoBack()
    {
        if (navigation.Count == 0) { Hide(); return; }
        navigation.RemoveAt(navigation.Count - 1);
        RenderActive();
    }

    private void Render(IReadOnlyList<TrayMenuEntry> entries, string? title)
    {
        Rows.Children.Clear();
        if (title is not null) Rows.Children.Add(BackBar(title));
        foreach (var entry in entries) Rows.Children.Add(BuildRow(entry));
        Scroller.ScrollToTop();
        var first = Rows.Children.OfType<Button>().FirstOrDefault(b => b.IsEnabled);
        if (first is not null) Dispatcher.InvokeAsync(() => Keyboard.Focus(first),
            DispatcherPriority.Input);
    }

    private FrameworkElement BuildRow(TrayMenuEntry entry) => entry.Kind switch
    {
        TrayMenuEntryKind.Separator => new Border
        {
            Height = 1, Margin = new Thickness(8, 4, 8, 4),
            Background = (Brush)Resources["LinkLine"],
        },
        TrayMenuEntryKind.Header => HeaderRow(entry),
        _ when !entry.Enabled && entry.Action is null && entry.Children is null => InfoRow(entry),
        _ => ActionRow(entry),
    };

    private FrameworkElement HeaderRow(TrayMenuEntry entry)
    {
        var grid = new Grid { Margin = new Thickness(4, 2, 4, 4) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var mark = new Image
        {
            Width = 20, Height = 20, Margin = new Thickness(0, 0, 9, 0),
            Source = (ImageSource)Resources["BrandMark"], VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(mark, 0);
        var text = new TextBlock
        {
            Text = entry.Text, FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        Grid.SetColumn(text, 1);
        grid.Children.Add(mark);
        grid.Children.Add(text);
        return grid;
    }

    private FrameworkElement InfoRow(TrayMenuEntry entry)
    {
        var grid = RowGrid();
        AddIcon(grid, entry, warning: false);
        var text = new TextBlock
        {
            Text = entry.Text, VerticalAlignment = VerticalAlignment.Center, FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)Resources["LinkSecondary"],
            TextWrapping = TextWrapping.Wrap,
        };
        var content = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        content.Children.Add(text);
        if (entry.Detail is { Length: > 0 } detail)
            content.Children.Add(new TextBlock
            {
                Text = detail, FontSize = 11, TextWrapping = TextWrapping.Wrap,
                Foreground = (Brush)Resources["LinkSecondary"],
            });
        Grid.SetColumn(content, 1);
        grid.Children.Add(content);
        return new Border { Padding = new Thickness(9, 7, 9, 7), Child = grid };
    }

    private FrameworkElement ActionRow(TrayMenuEntry entry)
    {
        var warning = entry.Kind == TrayMenuEntryKind.Problem;
        var grid = RowGrid();
        AddIcon(grid, entry, warning);
        var text = new TextBlock
        {
            Text = entry.Text, VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        if (warning) text.Foreground = (Brush)Resources["LinkWarn"];
        else if (entry.Kind == TrayMenuEntryKind.Item && !entry.Enabled)
            text.Foreground = (Brush)Resources["LinkSecondary"];
        if (entry.Detail is { Length: > 0 } detail)
        {
            var stack = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            stack.Children.Add(text);
            stack.Children.Add(new TextBlock
            {
                Text = detail, FontSize = 11, Margin = new Thickness(0, 1, 0, 0),
                TextTrimming = TextTrimming.CharacterEllipsis,
                Foreground = entry.DetailAccent
                    ? (Brush)Resources["LinkAccent"] : (Brush)Resources["LinkSecondary"],
            });
            Grid.SetColumn(stack, 1);
            grid.Children.Add(stack);
        }
        else
        {
            Grid.SetColumn(text, 1);
            grid.Children.Add(text);
        }
        if (entry.Kind == TrayMenuEntryKind.Submenu)
            grid.Children.Add(Glyph("next", 2));
        else if (entry.Kind == TrayMenuEntryKind.CheckItem)
            grid.Children.Add(SwitchGlyph(entry.Checked));
        var button = new Button
        {
            Style = (Style)Resources["RowButton"],
            Content = grid,
            IsEnabled = entry.Enabled,
        };
        AutomationProperties.SetName(button, entry.Text);
        button.Click += async (_, _) => await ActivateAsync(entry);
        return button;
    }

    private async Task ActivateAsync(TrayMenuEntry entry)
    {
        if (entry.Kind == TrayMenuEntryKind.Submenu && entry.Children is { } children)
        {
            navigation.Add((entry.Text, children));
            RenderActive();
            return;
        }
        await DispatchAsync(entry);
    }

    private async Task DispatchAsync(TrayMenuEntry entry)
    {
        if (dispatching && entry.Action != "openMain") return;
        if (ClosesBefore.Contains(entry.Action)) Hide();
        dispatching = true;
        SetFeedback(null);
        try { await dispatch(entry); }
        finally { dispatching = false; }
    }

    private FrameworkElement BackBar(string title)
    {
        var bar = new StackPanel();
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var back = new Button
        {
            Style = (Style)Resources["RowButton"],
            Padding = new Thickness(4),
            Content = Glyph("back"),
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center,
        };
        back.Click += (_, _) => GoBack();
        Grid.SetColumn(back, 0);
        var text = new TextBlock
        {
            Text = title, FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(6, 0, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        Grid.SetColumn(text, 1);
        grid.Children.Add(back);
        grid.Children.Add(text);
        bar.Children.Add(grid);
        bar.Children.Add(new Border
        {
            Height = 1, Margin = new Thickness(8, 4, 8, 4),
            Background = (Brush)Resources["LinkLine"],
        });
        return bar;
    }

    private Grid RowGrid()
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        return grid;
    }

    private void AddIcon(Grid grid, TrayMenuEntry entry, bool warning)
    {
        var stroke = warning ? (Brush)Resources["LinkWarn"] : (Brush)Resources["LinkSecondary"];
        if (!warning && entry.Tint is { Length: > 0 } tint)
        {
            try { stroke = new SolidColorBrush((Color)ColorConverter.ConvertFromString(tint)); }
            catch (FormatException) { }
        }
        if (entry.Badge is { } engine)
        {
            var tile = EngineBadge.Tile(engine, stroke);
            tile.Margin = new Thickness(0, 0, 10, 0);
            tile.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(tile, 0);
            grid.Children.Add(tile);
            return;
        }
        if (entry.Icon is not { } name || !Icons.TryGetValue(name, out var geometry)) return;
        var viewbox = new Viewbox
        {
            Width = 15, Height = 15, Margin = new Thickness(1, 0, 10, 0),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new System.Windows.Shapes.Path
            {
                Data = geometry,
                Stroke = stroke,
                StrokeThickness = 1.5,
                StrokeLineJoin = PenLineJoin.Round,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
            },
        };
        Grid.SetColumn(viewbox, 0);
        grid.Children.Add(viewbox);
    }

    private FrameworkElement Glyph(string name, int column = 0)
    {
        var viewbox = new Viewbox
        {
            Width = 12, Height = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Child = new System.Windows.Shapes.Path
            {
                Data = Icons[name],
                Stroke = (Brush)Resources["LinkSecondary"],
                StrokeThickness = 1.7,
                StrokeLineJoin = PenLineJoin.Round,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
            },
        };
        Grid.SetColumn(viewbox, column);
        return viewbox;
    }

    private FrameworkElement SwitchGlyph(bool on)
    {
        var grid = new Grid { Width = 32, Height = 18, VerticalAlignment = VerticalAlignment.Center };
        grid.Children.Add(new Border
        {
            CornerRadius = new CornerRadius(9),
            Background = on ? (Brush)Resources["LinkAccent"] : (Brush)Resources["LinkSubtle"],
            BorderThickness = new Thickness(1),
            BorderBrush = on ? (Brush)Resources["LinkAccent"] : (Brush)Resources["LinkSecondary"],
        });
        grid.Children.Add(new System.Windows.Shapes.Ellipse
        {
            Width = 10, Height = 10,
            Fill = on ? (Brush)Resources["LinkOnAccent"] : (Brush)Resources["LinkSecondary"],
            HorizontalAlignment = on ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            Margin = new Thickness(3, 0, 3, 0),
        });
        Grid.SetColumn(grid, 2);
        return grid;
    }

    private static Geometry Parse(string data)
    {
        var geometry = Geometry.Parse(data);
        geometry.Freeze();
        return geometry;
    }
}
