import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listProjects } from '../../api/client';
import type { Project } from '../../types';
import Sidebar from './Sidebar';
import { useEventStream } from '../../hooks/useEventStream';

function Layout() {
  useEventStream();

  const { data: projects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  const sidebarProjects = (projects ?? []).map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
  }));

  return (
    <div className="min-h-screen bg-gray-950 text-gray-300">
      <Sidebar projects={sidebarProjects} />
      <main className="ml-64 min-h-screen">
        <Outlet />
      </main>
    </div>
  );
}

export default Layout;
