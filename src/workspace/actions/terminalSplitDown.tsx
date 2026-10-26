import { Rows2 } from 'lucide-react';
import { paneCommandAction } from './paneCommand';

export default paneCommandAction({
    id: 'terminal-split-down',
    order: 103,
    labelKey: 'terminal.actions.splitDown',
    icon: Rows2,
    command: 'split-down',
    keywords: 'split pane panes panel paneles dividir'
});
