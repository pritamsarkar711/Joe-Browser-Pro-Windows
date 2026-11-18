// Chrome Web Store listing logos, provided by the publishers via the official listings.
export const INCLUDED_EXTENSIONS = [
  { id: 'fklakbbaaknbgcedidhblbnhclijnhbi', name: 'HTTP Tracker', url: 'https://chromewebstore.google.com/detail/http-tracker/fklakbbaaknbgcedidhblbnhclijnhbi', icon: './brand/http-tracker.png' },
  { id: 'okaeekdeohehbdanbbohcfhhlblcmjkm', name: 'Absolute Enable Right Click & Copy', url: 'https://chromewebstore.google.com/detail/absolute-enable-right-cli/okaeekdeohehbdanbbohcfhhlblcmjkm', icon: './brand/absolute-right-click.png' },
];

const EXTENSION_DETAILS: Record<string, string> = {
  'SingleFile': 'Archiving · Save a complete web page as one HTML file.',
  'Consent-O-Matic': 'Privacy · Apply your cookie-consent preferences automatically.',
  'Dark Reader': 'Appearance · Dark themes for websites; may change page rendering.',
  'Cookie-Editor': 'Diagnostics · Inspect and edit cookies. Cookie exports contain sensitive credentials.',
  'Wappalyzer': 'Diagnostics · Identify website technologies.',
  'Google Translate': 'Productivity · Translate pages using Google services.',
  'Clear Cache': 'Maintenance · Clear browser cache; review deletion options first.',
  'JSONVue': 'Diagnostics · Read JSON responses with structured formatting.',
  'WebRTC Leak Prevent': 'Privacy · Configure WebRTC policies; may affect calls.',
  'Privacy Badger': 'Privacy · Limit third-party tracking; may affect site functionality.',
  'uBlock Origin Lite': 'Privacy · Manifest V3 content blocking; enable only one content blocker at a time.',
};

export const RECOMMENDED_EXTENSIONS = [
  { name: 'uBlock Origin Lite', url: 'https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh', icon: '' },
  { name: 'SingleFile', url: 'https://chromewebstore.google.com/detail/singlefile/mpiodijhokgodhhofbcjdecpffjipkle', icon: './brand/singlefile.png' },
  { name: 'Consent-O-Matic', url: 'https://chromewebstore.google.com/detail/consent-o-matic/mdjildafknihdffpkfmmpnpoiajfjnjd', icon: './brand/consent-o-matic.png' },
  { name: 'Dark Reader', url: 'https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh', icon: './brand/dark-reader.png' },
  { name: 'Cookie-Editor', url: 'https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm', icon: './brand/cookie-editor.png' },
  { name: 'Wappalyzer', url: 'https://chromewebstore.google.com/detail/wappalyzer-technology-pro/gppongmhjkpfnbhagpmjfkannfbllamg', icon: './brand/wappalyzer.png' },
  { name: 'Google Translate', url: 'https://chromewebstore.google.com/detail/google-translate/aapbdbdomjkkjkaonfhkkikfgjllcleb', icon: './brand/google-translate.png' },
  { name: 'Clear Cache', url: 'https://chromewebstore.google.com/detail/clear-cache/cppjkneekbjaeellbfkmgnhonkkjfpdn', icon: './brand/clear-cache.png' },
  { name: 'JSONVue', url: 'https://chromewebstore.google.com/detail/jsonvue/chklaanhfefbnpoihckbnefhakgolnmc', icon: './brand/jsonvue.png' },
  { name: 'WebRTC Leak Prevent', url: 'https://chromewebstore.google.com/detail/webrtc-leak-prevent/eiadekoaikejlgdbkbdfeijglgfdalml', icon: './brand/webrtc-leak-prevent.png' },
  { name: 'Privacy Badger', url: 'https://chromewebstore.google.com/detail/privacy-badger/pkehgijcmpdhfbdbbnkijodmdjhbjlgp', icon: './brand/privacy-badger.png' },
].map((entry) => ({ ...entry, description: EXTENSION_DETAILS[entry.name] || '' }));
