import { Outlet } from 'react-router-dom';
import { useEventStream } from '../../hooks/useEventStream';
import TopNav from './TopNav';
import AppFooter from './AppFooter';

function Layout() {
  useEventStream();

  return (
    <div className="min-h-screen bg-gray-950 text-gray-300 flex flex-col">
      <TopNav />
      <main className="flex-1 pt-14">
        <Outlet />
      </main>
      <AppFooter />
    </div>
  );
}

export default Layout;
