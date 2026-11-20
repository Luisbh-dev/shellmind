import type en from '../en/welcome';

const es: typeof en = {
    title: 'Bienvenido a ShellMind',
    subtitle: 'Tu espacio de trabajo autoalojado para SSH, archivos, operaciones e IA.',
    actions: 'Para empezar',
    newConnection: {
        title: 'Nueva conexión',
        text: 'SSH, Windows, FTP, S3 o una CLI local'
    },
    importSsh: {
        title: 'Importar ~/.ssh/config',
        text: 'Trae los hosts que ya usas'
    },
    localShell: {
        title: 'Abrir una shell local',
        text: 'Un terminal en este equipo',
        name: 'Shell local',
        confirmTitle: '¿Crear una shell local?',
        confirmMessage: 'Todavía no hay ninguna shell local entre tus conexiones. ¿Crear «{name}» y abrirla?',
        confirm: 'Crear y abrir',
        failed: 'No se pudo crear la shell local',
        listFailed: 'La shell local se abre cuando tus conexiones se hayan cargado. Vuelve a intentarlo en un momento.'
    },
    palette: {
        title: 'Paleta de comandos',
        text: 'Servidores, pestañas y acciones, por nombre'
    },
    recent: 'Recientes',
    connections: 'Tus conexiones',
    lastOpened: 'Abierta {when}',
    notOpened: 'Sin abrir todavía',
    loading: 'Cargando conexiones',
    attention: {
        title: 'Requieren atención',
        open: 'Abrir la salud de la flota',
        setupTitle: 'Salud de la flota',
        setupText: 'Mira de un vistazo qué servidores requieren atención y recibe un aviso cuando uno pase a crítico.',
        setup: 'Configurar',
        allGood: 'Los {count} servidores revisados están sin problemas',
        allGoodOne: 'El servidor revisado está sin problemas',
        more: '{count} más',
        checked: 'Revisado {when}'
    },
    whatsNew: {
        title: 'Novedades de la {version}',
        gpu: { title: 'Uso de GPU en Estado', text: 'Uso, temperatura, consumo y procesos de GPU en servidores NVIDIA' },
        spark: { title: 'Compatibilidad con DGX Spark', text: 'Memoria unificada bien entendida: sin VRAM inventada, solo lo que informa el equipo' },
        model: { title: 'MiniMax M3.1 Flash por defecto', text: 'El modelo recomendado, listo en cada chat nuevo' },
        pickers: { title: 'Selectores de grupos y etiquetas', text: 'Los grupos y etiquetas existentes en los desplegables de la app' }
    }
};

export default es;
