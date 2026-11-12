import {
  Activity,
  ArrowLeftRight,
  CreditCard,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Mail,
  Megaphone,
  Palette,
  Server,
  Settings,
  Users,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Milestone in which the page gets its real content (shown on the placeholder). */
  milestone?: number;
  description?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

// One entry per web module (Spec §4.1 / §13.1), named like the server modules.
export const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'People & money',
    items: [
      { to: '/members', label: 'Members', icon: Users, description: 'Who has access, until when, and what they owe.' },
      { to: '/payments', label: 'Payments', icon: CreditCard, milestone: 5, description: 'Every e-Transfer the app has seen, plus transfers awaiting deposit.' },
      { to: '/review-queue', label: 'Review queue', icon: Inbox, milestone: 5, description: 'Payments the app declined to apply automatically.' },
      { to: '/import-export', label: 'Import / export', icon: ArrowLeftRight, milestone: 4, description: 'CSV export and the side-by-side import wizard.' },
    ],
  },
  {
    label: 'Email',
    items: [
      { to: '/emails', label: 'Emails', icon: Mail, milestone: 7, description: 'The outbound queue: reminders, confirmations and deficit notices.' },
      { to: '/templates', label: 'Templates', icon: Palette, milestone: 7, description: 'Template packs, the editor and live preview.' },
      { to: '/announcements', label: 'Announcements', icon: Megaphone, milestone: 8, description: 'Mass emails to chosen audiences.' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/media', label: 'Servers', icon: Server, milestone: 9, description: 'Plex and Jellyfin servers, libraries and enforcement.' },
      { to: '/settings', label: 'Settings', icon: Settings },
      { to: '/system', label: 'System', icon: Activity },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);
