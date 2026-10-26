import type en from '../en/tunnels';

const es: typeof en = {
    tab: 'Túneles',
    title: 'Túneles SSH',
    subtitle: 'Accede a bases de datos, aplicaciones web y APIs detrás de {server} a través de un puerto de este equipo, por la conexión SSH.',
    add: 'Nuevo túnel',
    listLabel: 'Túneles de {server}',
    loading: 'Cargando túneles…',
    loadFailed: 'No se pudieron cargar los túneles.',
    retry: 'Reintentar',
    empty: {
        title: 'Todavía no hay túneles',
        hint: 'Redirige un puerto local a un servicio que solo es accesible desde este servidor. Elige un servicio para empezar.'
    },
    presets: {
        title: 'Inicio rápido',
        label: 'Nuevo túnel para {service}',
        custom: 'Personalizado'
    },
    state: {
        stopped: 'Detenido',
        starting: 'Iniciando…',
        listening: 'Escuchando',
        error: 'Error'
    },
    card: {
        autoStart: 'Inicio automático',
        autoStartHint: 'Se inicia al arrancar ShellMind',
        exposed: 'Red',
        exposedHint: 'Escucha en {address}: otros equipos de tu red pueden usar este túnel.',
        route: 'Desde {local} en este equipo hasta {remote} visto desde el servidor',
        connections: '{active} abiertas · {total} en total',
        received: 'Recibido {bytes}',
        sent: 'Enviado {bytes}',
        lastError: 'Último error a las {time}'
    },
    actions: {
        toggle: 'Activar el túnel {name}',
        copy: 'Copiar la dirección local {address}',
        open: 'Abrir {url} en el navegador',
        edit: 'Editar el túnel {name}',
        delete: 'Eliminar el túnel {name}'
    },
    confirmDelete: {
        title: '¿Eliminar este túnel?',
        message: '«{name}» se detendrá y se eliminará. Se cerrarán las conexiones que pasen por él.',
        confirm: 'Eliminar túnel'
    },
    toast: {
        started: 'Túnel escuchando en {address}',
        stopped: 'Túnel {name} detenido',
        created: 'Túnel {name} creado',
        saved: 'Túnel {name} guardado',
        deleted: 'Túnel {name} eliminado',
        copied: 'Copiado {address}',
        copyFailed: 'No se pudo copiar al portapapeles',
        startFailed: 'No se pudo iniciar el túnel {name}',
        startCancelled: 'Se canceló el inicio del túnel {name}',
        stopFailed: 'No se pudo detener el túnel {name}',
        deleteFailed: 'No se pudo eliminar el túnel',
        restartFailed: 'El túnel {name} se guardó, pero no se pudo reiniciar'
    },
    errors: {
        PORT_IN_USE: 'El puerto local {port} ya está en uso. Elige otro puerto local o detén el programa o túnel que lo usa.',
        PORT_IN_USE_TUNNEL: 'El puerto local {port} ya lo usa el túnel «{tunnel}». Detén ese túnel o elige otro puerto local.',
        PORT_ACCESS_DENIED: 'No hay permiso para escuchar en el puerto {port}: los puertos por debajo de 1024 requieren permisos de administrador y Windows reserva algunos rangos. Elige otro puerto local.',
        BIND_ADDRESS_UNAVAILABLE: '{host} no es una dirección de este equipo.',
        LISTEN_FAILED: 'No se pudo escuchar en el puerto local.',
        SSH_CONNECT_FAILED: 'No se pudo conectar al servidor por SSH.',
        SSH_DISCONNECTED: 'Se cayó la conexión SSH. Se volverá a abrir con la siguiente conexión.',
        REMOTE_UNREACHABLE: 'El servidor no pudo conectar con {remote}. ¿Está el servicio en marcha y escuchando ahí?',
        FORWARDING_DENIED: 'El servidor SSH no permite redirigir puertos hacia {remote}. Pide a su administrador que lo habilite para tu cuenta (AllowTcpForwarding, PermitOpen en sshd_config).',
        TUNNEL_START_CANCELLED: 'El túnel se detuvo o cambió su configuración mientras se iniciaba.',
        INVALID_TUNNEL: 'El valor de «{field}» no es válido.',
        INVALID_TUNNEL_ANY: 'La configuración del túnel no es válida.',
        PUBLIC_BIND_UNCONFIRMED: 'Escuchar en {host} permite que otros equipos de la red usen este túnel. Confírmalo en la configuración del túnel o escucha en 127.0.0.1.',
        HOST_KEY_MISMATCH: 'La clave de host del servidor ha cambiado. Revísala en Clave de host antes de confiar en la nueva.',
        SECRET_UNREADABLE: 'Las credenciales guardadas de este servidor no se pueden descifrar. Vuelve a introducirlas en los ajustes de la conexión.',
        UNSUPPORTED_SERVER: 'Los túneles solo están disponibles para servidores SSH (Linux o Windows).',
        UNSUPPORTED_PURPOSE: 'Este servidor ya no es un servidor SSH, así que sus túneles no pueden conectarse. Vuelve a cambiar su tipo a Linux o Windows.',
        JUMP_HOST: 'No se puede usar el servidor de salto (bastión) configurado para este servidor.',
        PRIVATE_KEY_FILE: 'No se puede leer el archivo de clave privada de este servidor.',
        SERVER_NOT_FOUND: 'Este servidor ya no existe.',
        TUNNEL_NOT_FOUND: 'Este túnel ya no existe.'
    },
    form: {
        createTitle: 'Nuevo túnel',
        editTitle: 'Editar túnel',
        description: 'Las conexiones a la dirección local se reenvían a través de {server} hasta la dirección remota.',
        service: 'Servicio',
        name: 'Nombre',
        namePlaceholder: 'p. ej. Base de datos de producción',
        localSection: 'En este equipo',
        localHost: 'Dirección de escucha',
        localHostHint: '127.0.0.1 mantiene el túnel privado para este equipo.',
        localPort: 'Puerto local',
        localPortHint: 'Los programas de este equipo se conectan a {address}.',
        remoteSection: 'Visto desde {server}',
        remoteHost: 'Host remoto',
        remoteHostHint: '127.0.0.1 es el propio servidor; usa un nombre o una dirección para llegar a otra máquina de su red.',
        remotePort: 'Puerto remoto',
        autoStart: 'Iniciar automáticamente al arrancar ShellMind',
        exposedTitle: 'Accesible desde tu red',
        exposedBody: 'Escuchar en {host} permite que cualquier equipo que llegue a este use el túnel para acceder a {remote}, sin iniciar sesión.',
        exposedConfirm: 'Lo entiendo: escuchar en {host}',
        exposedRequired: 'Marca la confirmación de arriba para escuchar en {host}, o usa 127.0.0.1.',
        restartHint: 'Este túnel está activo: se reiniciará con la nueva configuración.',
        invalidPort: 'Introduce un puerto entre 1 y 65535.',
        invalidLocalHost: 'Introduce una dirección IP de este equipo, como 127.0.0.1.',
        invalidRemoteHost: 'Introduce un nombre de host o una dirección IP.',
        save: 'Guardar',
        saveAndStart: 'Guardar e iniciar',
        saveFailed: 'No se pudo guardar el túnel.'
    }
};

export default es;
