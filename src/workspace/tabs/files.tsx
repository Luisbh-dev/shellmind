import { lazyWithRetry } from '@/lib/lazy';
import { FileText } from 'lucide-react';
import type { WorkspaceTab } from '../types';

const FileExplorer = lazyWithRetry(() => import('@/features/files/FileExplorer'));

const filesTab: WorkspaceTab = {
    id: 'files',
    order: 20,
    labelKey: 'app.tabs.files',
    icon: FileText,
    isAvailable: (server) => server.type !== 'local',
    // File transfer is the main purpose of FTP and S3 connections.
    isPreferredFor: (server) => server.type === 'ftp' || server.type === 's3',
    Component: ({ server, isActive }) => <FileExplorer server={server} isActive={isActive} />
};

export default filesTab;
