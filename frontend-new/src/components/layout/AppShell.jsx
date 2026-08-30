/**
 * @file src/components/layout/AppShell.jsx
 * @brief Renders the overall application shell framework.
 * 
 * Embeds Header and BottomNav, wraps child routes in standard spacing layout frameworks,
 * and handles safe-area padding adjustments to avoid overlapping bottom bars.
 */


import BottomNav from './BottomNav';
import Header from './Header';

/**
 * @brief Layout shell component.
 * @param {ReactNode} props.children - Route sub-page nested inside main.
 * @param {string} props.title - Current route title text.
 * @param {boolean} props.showBack - Whether to show the back-arrow button.
 * @param {function} props.onBack - Back action callback hook.
 */
export default function AppShell({ children, title = '', showBack = false, onBack }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      minHeight: '100vh',
      backgroundColor: 'var(--bg-app)',
      color: 'var(--text-primary)'
    }}>
      {/* Main Workspace */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0, // prevents flex items from overflowing horizontally
        paddingBottom: '70px' // padding to avoid overlap with the 64px bottom navigation bar
      }}>
        <Header title={title} showBack={showBack} onBack={onBack} />
        <main style={{ flex: 1, overflowY: 'auto', scrollbarGutter: 'stable' }}>
          {children}
        </main>
      </div>

      {/* Navigation Layer */}
      <BottomNav />
    </div>
  );
}
