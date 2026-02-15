using Microsoft.UI;
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
}
