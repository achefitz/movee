import { Alert, Platform } from 'react-native';

/**
 * Yes/no confirmation that works everywhere. React Native Web's Alert.alert ignores
 * buttons (it shows nothing), so on web this uses the browser's confirm dialog.
 */
export function confirmAction(title: string, message: string, confirmLabel: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
