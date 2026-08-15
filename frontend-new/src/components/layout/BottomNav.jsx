/**
 * @file src/components/layout/BottomNav.jsx
 * @brief Renders the application bottom navigation bar.
 * 
 * Provides quick routing links (Home Dashboard vs Settings). Shows or hides Settings tab
 * based on user administrator privilege flags to prevent raw endpoint adjustments by guest accounts.
 */


import { useLocation, Link } from 'react-router';
import { Home, Sliders } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useHome } from '../../context/HomeContext';
import { useAuth } from '../../hooks/useAuth';

/**
 * @brief BottomNav layout component.
 */
export default function BottomNav() {
  const location = useLocation();
  const { t } = useTranslation();
  const { homeInfo } = useHome();
  const { user } = useAuth();

  const isAdmin = homeInfo && user ? (homeInfo.isCurrentUserAdmin || String(user.id) === String(homeInfo.adminUserId)) : true;

  const navItems = [
    { path: '/', label: t('nav.home'), icon: <Home size={22} /> }
  ];

  if (isAdmin) {
    navItems.push({ path: '/settings', label: t('nav.settings'), icon: <Sliders size={22} /> });
  }

  return (
    <nav style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: '64px',
      backgroundColor: 'var(--bg-card)',
      backdropFilter: 'blur(var(--glass-blur))',
      borderTop: '1px solid var(--border-color)',
      display: 'flex',
      justifyContent: 'space-around',
      alignItems: 'center',
      zIndex: 900,
      paddingBottom: 'safe-area-inset-bottom',
      boxShadow: '0 -4px 16px rgba(0,0,0,0.15)'
    }}>
      {navItems.map((item) => {
        const isActive = item.path === '/' 
          ? location.pathname === '/' 
          : location.pathname.startsWith(item.path);

        return (
          <Link
            key={item.path}
            to={item.path}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: isActive ? 'var(--primary)' : 'var(--text-secondary)',
              textDecoration: 'none',
              fontSize: '0.75rem',
              fontWeight: isActive ? 600 : 400,
              gap: '2px',
              flex: 1,
              height: '100%',
              transition: 'color var(--transition-fast)'
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'transform var(--transition-fast)',
              transform: isActive ? 'scale(1.1)' : 'scale(1)'
            }}>
              {item.icon}
            </div>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
