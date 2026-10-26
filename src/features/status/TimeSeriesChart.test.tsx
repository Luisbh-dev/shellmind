import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TimeSeriesChart } from './TimeSeriesChart';

const base = {
    times: [1000, 2000, 3000],
    start: 0,
    end: 3000,
    yMax: 100,
    yTicks: [0, 50, 100],
    maxGapMs: 1500,
    formatValue: (value: number) => `${value}%`,
    formatTick: (value: number) => `${value}%`,
    formatTime: (time: number) => `t${time / 1000}`,
    formatAxisTime: (time: number) => `a${time / 1000}`,
    label: 'CPU usage',
    description: 'CPU, last 3 samples: lowest 10%, highest 40%, now 40%',
    emptyText: 'Collecting samples…',
};

const lines = (container: HTMLElement) => [...container.querySelectorAll('path')].filter((path) => path.getAttribute('fill') === 'none');

describe('TimeSeriesChart', () => {
    it('is a named, described control with labelled ticks and the window ends', () => {
        const { container } = render(<TimeSeriesChart {...base} series={[{ id: 'cpu', label: 'CPU', color: '#3987e5', values: [10, 20, 40] }]} />);
        const chart = screen.getByRole('slider', { name: 'CPU usage' });
        expect(chart).toHaveAccessibleDescription(base.description);
        // At rest it reads the latest sample.
        expect(chart).toHaveAttribute('aria-valuetext', 't3: CPU 40%');
        expect(chart).toHaveAttribute('aria-valuenow', '3');
        expect(screen.getByText('100%')).toBeInTheDocument();
        expect(screen.getByText('a0')).toBeInTheDocument();
        expect(screen.getByText('a3')).toBeInTheDocument();
        // One series: a line over a soft wash, and the end dot.
        expect(lines(container)).toHaveLength(1);
        expect(container.querySelector('linearGradient')).not.toBeNull();
        expect(container.querySelectorAll('[data-marker]')).toHaveLength(1);
    });

    it('draws each series without a wash, and breaks lines at gaps', () => {
        const { container } = render(<TimeSeriesChart
            {...base}
            times={[1000, 2000, 3000, 9000]}
            end={9000}
            series={[
                { id: 'rx', label: 'Received', color: '#3987e5', values: [10, 20, 30, 40] },
                { id: 'tx', label: 'Sent', color: '#d95926', values: [5, null, 5, 5] },
            ]}
        />);
        expect(container.querySelector('linearGradient')).toBeNull();
        // rx: 1-2-3 then a pause before 9 (a lone dot); tx: 1, then 3 (lone dots: a gap and a missing value).
        expect(lines(container)).toHaveLength(1);
        expect(container.querySelectorAll('g[data-series="rx"] circle')).toHaveLength(1);
        expect(container.querySelectorAll('g[data-series="tx"] circle')).toHaveLength(3);
    });

    it('steps through the samples from the keyboard and shows them', () => {
        render(<TimeSeriesChart {...base} series={[
            { id: 'rx', label: 'Received', color: '#3987e5', values: [10, 20, 40] },
            { id: 'tx', label: 'Sent', color: '#d95926', values: [1, null, 3] },
        ]} />);
        const chart = screen.getByRole('slider');
        fireEvent.focus(chart);
        expect(screen.getByText('t3')).toBeInTheDocument();
        fireEvent.keyDown(chart, { key: 'ArrowLeft' });
        expect(chart).toHaveAttribute('aria-valuetext', 't2: Received 20%, Sent —');
        expect(screen.getByText('t2')).toBeInTheDocument();
        fireEvent.keyDown(chart, { key: 'Home' });
        expect(chart).toHaveAttribute('aria-valuenow', '1');
        fireEvent.keyDown(chart, { key: 'ArrowLeft' });
        expect(chart).toHaveAttribute('aria-valuenow', '1');
        fireEvent.keyDown(chart, { key: 'End' });
        expect(chart).toHaveAttribute('aria-valuetext', 't3: Received 40%, Sent 3%');
        fireEvent.keyDown(chart, { key: 'Escape' });
        expect(screen.queryByText('t3')).toBeNull();
    });

    it('follows the pointer to the nearest sample', () => {
        render(<TimeSeriesChart {...base} series={[{ id: 'cpu', label: 'CPU', color: '#3987e5', values: [10, 20, 40] }]} />);
        const chart = screen.getByRole('slider');
        // jsdom reports a zero-sized box: the pointer lands at the window start.
        fireEvent.pointerMove(chart, { clientX: 0 });
        expect(screen.getByText('t1')).toBeInTheDocument();
        expect(screen.getByText('10%')).toBeInTheDocument();
        fireEvent.pointerLeave(chart);
        expect(screen.queryByText('t1')).toBeNull();
    });

    it('says it is collecting while no sample is in the window', () => {
        render(<TimeSeriesChart {...base} times={[]} series={[{ id: 'cpu', label: 'CPU', color: '#3987e5', values: [] }]} />);
        expect(screen.queryByRole('slider')).toBeNull();
        expect(screen.getByText('Collecting samples…')).toBeInTheDocument();
    });
});
