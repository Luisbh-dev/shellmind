import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { StatusDisk } from '@shared/status';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { DiskList } from './DiskList';
import { DISK_ACTION_ID, useDiskTarget } from '@/store/diskView';

// W8-T4: the Status page's filesystem rows open the disk toolkit.

const disk = (mount: string, usagePercent: number): StatusDisk => ({ name: `/dev/${mount.length}`, mount, fsType: 'ext4', totalGB: 100, usedGB: usagePercent, freeGB: 100 - usagePercent, usagePercent });

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
    useDiskTarget.setState({ target: null });
});

afterEach(() => setLanguage('system'));

describe('filesystem rows of the Status page', () => {
    it('explore their filesystem, and offer to free space from warning on', () => {
        render(<DiskList serverId={3} disks={[disk('/', 40), disk('/var', 85), disk('/data', 97)]} />);
        expect(screen.getAllByRole('button', { name: /^Explore / }).map((button) => button.getAttribute('aria-label'))).toEqual(['Explore /', 'Explore /var', 'Explore /data']);
        expect(screen.getAllByRole('button', { name: /^Free up space on / }).map((button) => button.getAttribute('aria-label'))).toEqual(['Free up space on /var', 'Free up space on /data']);

        fireEvent.click(screen.getByRole('button', { name: 'Explore /var' }));
        expect(useDiskTarget.getState().target).toEqual({ serverId: 3, mount: '/var', view: 'usage' });
        expect(useAppStore.getState().activeActionId).toBe(DISK_ACTION_ID);

        fireEvent.click(screen.getByRole('button', { name: 'Free up space on /data' }));
        expect(useDiskTarget.getState().target).toEqual({ serverId: 3, mount: '/data', view: 'cleanup' });
    });

    it('stay plain where no server is given', () => {
        render(<DiskList disks={[disk('/', 95)]} />);
        expect(screen.queryByRole('button')).toBeNull();
    });
});
