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
        fleet: { title: 'Salud de la flota', text: 'La salud de todos los servidores en una pantalla, con avisos' },
        panes: { title: 'Paneles y escritura simultánea', text: 'Terminales lado a lado, una línea escrita en varias' },
        containers: { title: 'Contenedores y Kubernetes', text: 'Compose, imágenes, pods y cargas, con shell dentro' },
        patch: { title: 'Parches y disco', text: 'Actualizaciones por lotes seguros, limpiezas con vista previa' },
        rdp: { title: 'Escritorio remoto integrado', text: 'Escritorios Windows en una pestaña, con certificados fijados' },
        diagnose: { title: 'Diagnóstico con IA', text: 'Pruebas reunidas en el servidor, luego la causa y la solución' },
        jobs: { title: 'Trabajos de ejecución múltiple', text: 'Despliegues con canario y salida agrupada por resultado' },
        security: { title: 'Llavero y auditoría', text: 'Identidades, agente SSH, credenciales cifradas y registro' },
        appearance: { title: 'Temas e idiomas', text: 'Claro y oscuro, colores de acento, español e inglés' }
    }
};

export default es;
