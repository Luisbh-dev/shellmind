import { Radio } from 'lucide-react';
import { paneCommandAction } from './paneCommand';

export default paneCommandAction({
    id: 'terminal-broadcast',
    order: 105,
    labelKey: 'terminal.actions.broadcast',
    icon: Radio,
    command: 'toggle-broadcast',
    keywords: 'broadcast input sync panes difusión simultánea escritura varios terminales'
});
