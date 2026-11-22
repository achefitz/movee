export type StreamingService = {
  name: string;
  color: string;
  url: string;
};

export const SVC: Record<number, StreamingService> = {
  8:    { name: 'Netflix',     color: '#E50914', url: 'https://www.netflix.com' },
  9:    { name: 'Prime',       color: '#00A8E1', url: 'https://www.amazon.com/Prime-Video' },
  15:   { name: 'Hulu',        color: '#1CE783', url: 'https://www.hulu.com' },
  337:  { name: 'Disney+',     color: '#0063E5', url: 'https://www.disneyplus.com' },
  350:  { name: 'Apple TV+',   color: '#A2AAAD', url: 'https://tv.apple.com' },
  386:  { name: 'Peacock',     color: '#00A2E8', url: 'https://www.peacocktv.com' },
  531:  { name: 'Paramount+',  color: '#0064FF', url: 'https://www.paramountplus.com' },
  1899: { name: 'Max',         color: '#002BE7', url: 'https://www.max.com' },
  2:    { name: 'Apple TV',    color: '#A2AAAD', url: 'https://tv.apple.com' },
  10:   { name: 'Amazon',      color: '#FF9900', url: 'https://www.amazon.com/Prime-Video' },
  283:  { name: 'Crunchyroll',  color: '#F47521', url: 'https://www.crunchyroll.com' },
  37:   { name: 'Showtime',     color: '#EE0000', url: 'https://www.sho.com' },
  43:   { name: 'Starz',        color: '#111111', url: 'https://www.starz.com' },
};

export const AMC_URL = 'https://www.amctheatres.com';

export const STREAMING_FILTER_LIST = [
  { id: 8,    name: 'Netflix' },
  { id: 9,    name: 'Prime' },
  { id: 15,   name: 'Hulu' },
  { id: 337,  name: 'Disney+' },
  { id: 350,  name: 'Apple TV+' },
  { id: 386,  name: 'Peacock' },
  { id: 531,  name: 'Paramount+' },
  { id: 1899, name: 'Max' },
];
