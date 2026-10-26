import { ArrowRightLeft } from 'lucide-react';
import { paneCommandAction } from './paneCommand';

export default paneCommandAction({
    id: 'terminal-next-pane',
    order: 104,
    labelKey: 'terminal.actions.nextPane',
    icon: ArrowRightLeft,
    command: 'focus-next',
    keywords: 'pane panes focus panel paneles foco siguiente'
});
