import { siTelegram } from 'simple-icons';
import type { ComponentType, ReactNode } from 'react';
import People from '@mui/icons-material/People';
import History from '@mui/icons-material/History';
import Router from '@mui/icons-material/Router';
import Extension from '@mui/icons-material/Extension';
import Public from '@mui/icons-material/Public';
import Build from '@mui/icons-material/Build';
import Settings from '@mui/icons-material/Settings';
import Info from '@mui/icons-material/Info';
import Add from '@mui/icons-material/Add';
import Remove from '@mui/icons-material/Remove';
import Close from '@mui/icons-material/Close';
import Check from '@mui/icons-material/Check';
import ExpandMore from '@mui/icons-material/ExpandMore';
import ChevronRight from '@mui/icons-material/ChevronRight';
import ChevronLeft from '@mui/icons-material/ChevronLeft';
import Search from '@mui/icons-material/Search';
import PlayArrow from '@mui/icons-material/PlayArrow';
import Stop from '@mui/icons-material/Stop';
import OpenInNew from '@mui/icons-material/OpenInNew';
import Folder from '@mui/icons-material/Folder';
import Delete from '@mui/icons-material/Delete';
import Edit from '@mui/icons-material/Edit';
import ContentCopy from '@mui/icons-material/ContentCopy';
import Refresh from '@mui/icons-material/Refresh';
import Language from '@mui/icons-material/Language';
import Download from '@mui/icons-material/Download';
import Upload from '@mui/icons-material/Upload';
import VpnKey from '@mui/icons-material/VpnKey';
import Lock from '@mui/icons-material/Lock';
import LockOpen from '@mui/icons-material/LockOpen';
import Logout from '@mui/icons-material/Logout';
import QrCode from '@mui/icons-material/QrCode';
import Schedule from '@mui/icons-material/Schedule';
import Layers from '@mui/icons-material/Layers';
import Visibility from '@mui/icons-material/Visibility';
import FilterList from '@mui/icons-material/FilterList';
import Sort from '@mui/icons-material/Sort';
import GridView from '@mui/icons-material/GridView';
import ViewList from '@mui/icons-material/ViewList';
import LightMode from '@mui/icons-material/LightMode';
import DarkMode from '@mui/icons-material/DarkMode';
import Memory from '@mui/icons-material/Memory';
import DesktopWindows from '@mui/icons-material/DesktopWindows';
import PhoneIphone from '@mui/icons-material/PhoneIphone';
import Wifi from '@mui/icons-material/Wifi';
import Storage from '@mui/icons-material/Storage';
import Speed from '@mui/icons-material/Speed';
import Cookie from '@mui/icons-material/Cookie';
import Fingerprint from '@mui/icons-material/Fingerprint';
import Code from '@mui/icons-material/Code';
import PowerSettingsNew from '@mui/icons-material/PowerSettingsNew';
import Save from '@mui/icons-material/Save';
import Link from '@mui/icons-material/Link';
import Place from '@mui/icons-material/Place';
import Notifications from '@mui/icons-material/Notifications';
import Archive from '@mui/icons-material/Archive';
import Shuffle from '@mui/icons-material/Shuffle';
import Terminal from '@mui/icons-material/Terminal';
import GpsFixed from '@mui/icons-material/GpsFixed';
import Route from '@mui/icons-material/Route';
import Restore from '@mui/icons-material/Restore';
import Menu from '@mui/icons-material/Menu';
import MoreHoriz from '@mui/icons-material/MoreHoriz';
import MoreVert from '@mui/icons-material/MoreVert';
import Translate from '@mui/icons-material/Translate';

/**
 * The icon set - Google's Material icons.
 *
 * One import surface for the whole app, so every glyph renders at a real size on the same grid:
 * flat, filled, pixel-aligned SVGs with `shape-rendering` tuned for small sizes. No shields, no
 * warning triangles, no lightning, no sparkles and no alarm glyphs are shipped - those families
 * are gone from this file rather than merely unused.
 */

interface MaterialIconProps {
  fontSize?: 'inherit' | 'large' | 'medium' | 'small';
  className?: string;
  style?: React.CSSProperties;
  titleAccess?: string;
}

const MATERIAL = {
  profiles: People,
  history: History,
  proxy: Router,
  extensions: Extension,
  browsers: Public,
  tools: Build,
  settings: Settings,
  about: Info,
  plus: Add,
  minus: Remove,
  close: Close,
  check: Check,
  chevronDown: ExpandMore,
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  search: Search,
  play: PlayArrow,
  stop: Stop,
  external: OpenInNew,
  folder: Folder,
  trash: Delete,
  edit: Edit,
  copy: ContentCopy,
  refresh: Refresh,
  globe: Language,
  download: Download,
  upload: Upload,
  key: VpnKey,
  lock: Lock,
  unlock: LockOpen,
  logout: Logout,
  qr: QrCode,
  clock: Schedule,
  layers: Layers,
  info: Info,
  eye: Visibility,
  filter: FilterList,
  sort: Sort,
  grid: GridView,
  list: ViewList,
  sun: LightMode,
  moon: DarkMode,
  cpu: Memory,
  monitor: DesktopWindows,
  phone: PhoneIphone,
  wifi: Wifi,
  database: Storage,
  speed: Speed,
  cookie: Cookie,
  fingerprint: Fingerprint,
  code: Code,
  brand: Language,
  power: PowerSettingsNew,
  save: Save,
  link: Link,
  pin: Place,
  bell: Notifications,
  archive: Archive,
  shuffle: Shuffle,
  terminal: Terminal,
  memory: Memory,
  target: GpsFixed,
  route: Route,
  history2: Restore,
  menu: Menu,
  dots: MoreHoriz,
  dotVertical: MoreVert,
  translate: Translate,
} as const satisfies Record<string, ComponentType<MaterialIconProps>>;

export type IconName = keyof typeof MATERIAL | 'telegram';

/** The one brand mark the Material set does not carry, drawn in the same filled style. */
function TelegramIcon({ size, className }: { size: number; className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Telegram"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={siTelegram.path} />
    </svg>
  );
}

export function Icon({
  name,
  size = 22,
  className,
  strokeWidth: _strokeWidth,
  fill,
}: {
  name: IconName;
  size?: number;
  className?: string;
  /** Accepted for compatibility; Material icons are filled, stroke has no effect. */
  strokeWidth?: number;
  fill?: string;
}): ReactNode {
  if (name === 'telegram') {
    return <TelegramIcon size={size} className={className} />;
  }
  const Glyph = MATERIAL[name];
  return (
    <Glyph
      fontSize="inherit"
      className={className}
      style={{ width: size, height: size, fontSize: size, color: fill, shapeRendering: 'geometricPrecision' }}
    />
  );
}
