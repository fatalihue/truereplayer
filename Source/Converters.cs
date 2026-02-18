using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Media;
using System;
using Windows.UI;

namespace TrueReplayer.Converters
{
    public class InsertionHighlightConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language)
        {
            return (value is bool shouldHighlight && shouldHighlight)
                ? new SolidColorBrush(Colors.Goldenrod)
                : new SolidColorBrush(Colors.Transparent);
        }

        public object ConvertBack(object value, Type targetType, object parameter, string language)
        {
            throw new NotImplementedException();
        }
    }

    public class NonNegativeIntConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language)
        {
            return value is int intValue ? intValue.ToString() : "0";
        }

        public object ConvertBack(object value, Type targetType, object parameter, string language)
        {
            if (value is string stringValue && int.TryParse(stringValue, out int result))
                return Math.Max(0, result);

            return 0;
        }
    }

    public class ActionTypeToBrushConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language)
        {
            string actionType = value as string ?? "";
            string param = parameter as string ?? "foreground";
            bool isBackground = param.Equals("background", StringComparison.OrdinalIgnoreCase);

            bool isMouse = actionType.Contains("Click", StringComparison.OrdinalIgnoreCase);
            bool isScroll = actionType.Contains("Scroll", StringComparison.OrdinalIgnoreCase);
            bool isKey = actionType.StartsWith("Key", StringComparison.OrdinalIgnoreCase);

            if (isMouse)
            {
                return new SolidColorBrush(isBackground
                    ? ColorHelper.FromArgb(0x1A, 0xA7, 0x8B, 0xFA)
                    : ColorHelper.FromArgb(0xFF, 0xA7, 0x8B, 0xFA));
            }
            if (isScroll)
            {
                return new SolidColorBrush(isBackground
                    ? ColorHelper.FromArgb(0x1A, 0x6B, 0xCB, 0x77)
                    : ColorHelper.FromArgb(0xFF, 0x6B, 0xCB, 0x77));
            }
            if (isKey)
            {
                return new SolidColorBrush(isBackground
                    ? ColorHelper.FromArgb(0x1A, 0x60, 0xCD, 0xFF)
                    : ColorHelper.FromArgb(0xFF, 0x60, 0xCD, 0xFF));
            }

            return new SolidColorBrush(Colors.Transparent);
        }

        public object ConvertBack(object value, Type targetType, object parameter, string language)
            => throw new NotImplementedException();
    }

    public class ActionTypeToIconConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language)
        {
            string actionType = value as string ?? "";

            if (actionType.Contains("Click", StringComparison.OrdinalIgnoreCase))
                return "\uE962";
            if (actionType.Contains("Scroll", StringComparison.OrdinalIgnoreCase))
                return "\uE74A";
            if (actionType.StartsWith("Key", StringComparison.OrdinalIgnoreCase))
                return "\uE765";

            return "\uE7C3";
        }

        public object ConvertBack(object value, Type targetType, object parameter, string language)
            => throw new NotImplementedException();
    }

    public class StringToVisibilityConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language)
        {
            return string.IsNullOrEmpty(value as string) ? Visibility.Collapsed : Visibility.Visible;
        }

        public object ConvertBack(object value, Type targetType, object parameter, string language)
            => throw new NotImplementedException();
    }

    public class BoolToVisibilityConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language)
        {
            return (value is bool b && b) ? Visibility.Visible : Visibility.Collapsed;
        }

        public object ConvertBack(object value, Type targetType, object parameter, string language)
            => throw new NotImplementedException();
    }

    public class ActiveProfileBrushConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language)
        {
            bool isActive = value is bool b && b;
            return new SolidColorBrush(isActive
                ? ColorHelper.FromArgb(0xFF, 0x60, 0xCD, 0xFF)
                : ColorHelper.FromArgb(0xFF, 0xFF, 0xFF, 0xFF));
        }

        public object ConvertBack(object value, Type targetType, object parameter, string language)
            => throw new NotImplementedException();
    }

    public class ActiveProfileFontWeightConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language)
        {
            bool isActive = value is bool b && b;
            return isActive
                ? Microsoft.UI.Text.FontWeights.SemiBold
                : Microsoft.UI.Text.FontWeights.Normal;
        }

        public object ConvertBack(object value, Type targetType, object parameter, string language)
            => throw new NotImplementedException();
    }
}
