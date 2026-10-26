import { Columns2 } from 'lucide-react';
import { paneCommandAction } from './paneCommand';

export default paneCommandAction({
    id: 'terminal-split-right',
    order: 102,
    labelKey: 'terminal.actions.splitRight',
    icon: Columns2,
    command: 'split-right',
    keywords: 'split pane panes panel paneles dividir'
});
