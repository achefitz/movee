import { Share, Platform } from 'react-native';
import { MediaItem } from '../services/tmdb';

export async function shareItem(item: MediaItem): Promise<void> {
  const url = `https://www.themoviedb.org/${item.type}/${item.id}`;
  const message = `Check out ${item.title} (${item.year}) — find it on Movee!\n${url}`;

  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined' && typeof (navigator as any).share === 'function') {
      try {
        await (navigator as any).share({ title: item.title, text: message, url });
        return;
      } catch {}
    }
    try {
      await navigator.clipboard.writeText(message);
    } catch {}
    return;
  }

  try {
    await Share.share({ message, url });
  } catch {}
}
