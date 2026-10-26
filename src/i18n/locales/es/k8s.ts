import type en from '../en/k8s';

const es: typeof en = {
    tab: 'Kubernetes',
    lookForKubectl: 'Kubernetes: buscar kubectl en este servidor',
    detecting: 'Buscando kubectl en este servidor…',
    detectingLocal: 'Buscando kubectl en este equipo…',
    redetectFailed: 'No se pudo volver a comprobar kubectl; la pestaña mantiene lo que encontró antes.',
    checkAgain: 'Volver a comprobar',
    install: 'Cómo instalar kubectl',
    retry: 'Reintentar',
    refresh: 'Actualizar',
    refreshFailed: 'No se pudo actualizar; la lista muestra lo que se leyó antes.',
    autoRefresh: 'Actualizar solo (10 s)',
    back: 'Volver a la lista',
    loading: 'Cargando…',
    more: 'Más',
    sortBy: 'Ordenar por {column}',
    context: 'Contexto de kubeconfig',
    currentContext: 'contexto actual de kubectl',
    namespace: 'Namespace',
    allNamespaces: 'Todos los namespaces',
    namespacesUnavailable: 'No se pueden listar los namespaces',
    otherNamespace: {
        option: 'Otro namespace…',
        title: 'Abrir otro namespace',
        description: 'Para un namespace en el que puedes trabajar pero que la lista no ofrece (cuando no tienes permiso para listar los namespaces del clúster).',
        invalid: 'Letras minúsculas, dígitos y «-», hasta 63 caracteres.',
        cancel: 'Cancelar',
        confirm: 'Abrir'
    },
    unsupportedContexts: 'Se han omitido (nombres con espacios, comillas o caracteres de shell): {names}.',
    unsupportedContext: 'No se puede usar: su nombre tiene espacios, comillas o caracteres de shell',
    viewsLabel: 'Vistas de Kubernetes',
    views: {
        workloads: 'Cargas',
        pods: 'Pods',
        events: 'Eventos',
        nodes: 'Nodos'
    },
    failingCount: '{count} pods con fallos',
    failingCountOne: '1 pod con fallos',
    runner: {
        ssh: 'kubectl {version} en el servidor',
        sshSudo: 'kubectl {version} en el servidor (sudo)',
        local: 'kubectl {version} en este equipo'
    },
    unavailable: {
        KUBECTL_MISSING: {
            ssh: 'kubectl no está instalado en este servidor',
            local: 'kubectl no está instalado en este equipo',
            hint: 'Instala kubectl y configura un kubeconfig; después vuelve a comprobarlo. En un servidor, ShellMind lo busca en el PATH de una sesión SSH no interactiva, en /usr/local/bin y en /snap/bin.'
        },
        NO_CONTEXTS: {
            ssh: 'kubectl no tiene ningún clúster con el que trabajar en este servidor',
            local: 'kubectl no tiene ningún clúster con el que trabajar en este equipo',
            hint: 'Su kubeconfig (~/.kube/config o $KUBECONFIG) no tiene contextos. Añade uno, por ejemplo con la CLI de tu proveedor, y vuelve a comprobarlo.'
        },
        KUBECONFIG_ERROR: {
            ssh: 'kubectl no puede leer su kubeconfig en este servidor',
            local: 'kubectl no puede leer su kubeconfig en este equipo',
            hint: 'kubectl ha respondido:'
        },
        UNSUPPORTED: {
            ssh: 'Kubernetes no está disponible para esta conexión',
            local: 'Kubernetes no está disponible para esta conexión',
            hint: 'Necesita una conexión SSH a un servidor Linux, o una conexión local con el preset de kubectl.'
        }
    },
    useContext: {
        action: 'Convertirlo en el contexto actual de kubectl',
        already: 'Ya es el contexto actual de kubectl',
        title: '¿Convertir {context} en el contexto actual?',
        message: 'A partir de ahora, kubectl en {server} usará {context} siempre que no se indique un contexto, también fuera de ShellMind. Esta pestaña siempre indica su contexto y no se ve afectada.',
        messageLocal: 'A partir de ahora, kubectl en este equipo usará {context} siempre que no se indique un contexto, también fuera de ShellMind. Esta pestaña siempre indica su contexto y no se ve afectada.',
        confirm: 'Convertir en actual',
        done: '{context} es ahora el contexto actual de kubectl.',
        failed: 'No se pudo cambiar el contexto actual.'
    },
    kinds: {
        deployment: 'Deployment',
        statefulset: 'StatefulSet',
        daemonset: 'DaemonSet',
        job: 'Job',
        cronjob: 'CronJob'
    },
    kindsPlural: {
        deployment: 'Deployments',
        statefulset: 'StatefulSets',
        daemonset: 'DaemonSets',
        job: 'Jobs',
        cronjob: 'CronJobs'
    },
    owners: {
        Deployment: 'Deployment {name}',
        StatefulSet: 'StatefulSet {name}',
        DaemonSet: 'DaemonSet {name}',
        Job: 'Job {name}',
        CronJob: 'CronJob {name}',
        ReplicaSet: 'ReplicaSet {name}',
        ReplicationController: 'ReplicationController {name}',
        Node: 'pod estático del nodo {name}'
    },
    health: {
        ok: 'Correcto',
        progressing: 'Desplegando',
        degraded: 'Degradado',
        failed: 'Fallido',
        idle: 'Inactivo',
        suspended: 'Suspendido',
        complete: 'Completado',
        running: 'En marcha'
    },
    workloads: {
        search: 'Buscar cargas',
        caption: '{count} cargas',
        captionOne: '1 carga',
        empty: 'No hay cargas en este namespace',
        noMatch: 'Ninguna carga coincide con la búsqueda',
        partial: 'Algunos tipos no se han podido listar (sin permiso)',
        columns: {
            name: 'Nombre',
            ready: 'Listos',
            upToDate: 'Actualizados',
            status: 'Estado',
            age: 'Edad',
            actions: 'Acciones'
        },
        available: '{count} disponibles',
        activeJobs: '{count} jobs activos',
        activeJobsOne: '1 job activo',
        succeeded: '{done}/{total} completados',
        actionsFor: 'Acciones de {name}',
        showPods: 'Ver sus {count} pods',
        showPodsOne: 'Ver su pod',
        restart: {
            action: 'Reiniciar (rollout)',
            title: '¿Reiniciar {kind} {name}?',
            message: 'kubectl rollout restart sustituye los pods de {name} por otros nuevos según su estrategia de actualización (de uno en uno en la mayoría de los deployments). Las peticiones a los pods que se están sustituyendo pueden fallar.',
            confirm: 'Reiniciar',
            done: 'Se ha iniciado el reinicio de {name}.',
            failed: 'No se pudo reiniciar {name}.'
        }
    },
    scale: {
        action: 'Escalar…',
        title: 'Escalar {kind} {name}',
        description: 'Ahora tiene {current} réplicas ({ready} listas).',
        replicas: 'Réplicas',
        hint: 'De 0 a {max}.',
        invalid: 'Escribe un número entero de 0 a {max}.',
        zero: 'Con 0 réplicas se detienen todos sus pods hasta que se vuelva a escalar.',
        cancel: 'Cancelar',
        confirm: 'Escalar',
        done: '{name} escalado a {count} réplicas.',
        doneOne: '{name} escalado a 1 réplica.',
        failed: 'No se pudo escalar {name}.'
    },
    pods: {
        search: 'Buscar pods, nodos, contenedores',
        filterLabel: 'Mostrar pods',
        filter: {
            all: 'Todos',
            problems: 'Requieren atención',
            running: 'En marcha',
            completed: 'Terminados'
        },
        ofWorkload: 'Pods de {kind} {name}',
        clearWorkload: 'Mostrar todos los pods',
        truncated: 'Solo se muestran los primeros {count} pods: elige un namespace para ver el resto.',
        caption: '{count} pods',
        captionOne: '1 pod',
        empty: 'Aquí no hay pods',
        emptyHint: 'El namespace {namespace} no tiene pods. Elige otro arriba.',
        emptyAll: 'El clúster no tiene pods que puedas listar.',
        noMatch: 'Ningún pod coincide con el filtro',
        columns: {
            name: 'Nombre',
            status: 'Estado',
            ready: 'Listos',
            restarts: 'Reinicios',
            node: 'Nodo',
            age: 'Edad',
            shell: 'Shell'
        },
        ago: 'hace {age}'
    },
    pod: {
        detailLabel: 'Pod {name}',
        gone: 'Este pod ya no aparece en la lista (puede que se haya eliminado o sustituido).',
        askAiHint: 'Se recopilan su estado, sus eventos y sus logs recientes, y se te muestran antes de enviar nada.',
        close: 'Cerrar el pod',
        actionsLabel: 'Acciones del pod',
        tabsLabel: 'Detalles del pod',
        tabs: {
            overview: 'Resumen',
            logs: 'Logs',
            events: 'Eventos'
        },
        namespace: 'Namespace',
        owner: 'Controlado por',
        noOwner: 'Nada (un pod suelto)',
        node: 'Nodo',
        unscheduled: 'Aún sin asignar',
        ip: 'IP del pod',
        hostIp: 'nodo {ip}',
        qos: 'Clase QoS',
        serviceAccount: 'Cuenta de servicio',
        created: 'Creado',
        started: 'Iniciado',
        conditions: 'Condiciones',
        initContainers: 'Contenedores de inicio',
        volumes: 'Volúmenes',
        delete: {
            action: 'Eliminar pod',
            title: '¿Eliminar el pod {name}?',
            replaced: 'Su {owner} crea un pod nuevo para sustituirlo: sirve para reiniciar un único pod atascado.',
            cleanup: 'El pod se ha detenido y su {owner} ya ejecuta otros en su lugar: eliminarlo solo lo retira, junto con sus logs.',
            jobRunning: 'Su {owner} puede crear otro pod para terminar el trabajo, si su límite de reintentos lo permite. Los logs de este pod se pierden.',
            jobFinished: 'El pod ya ha terminado y su {owner} no lo volverá a ejecutar: el pod y sus logs desaparecen para siempre.',
            otherOwner: 'Pertenece a {owner}, cuyo controlador decide si lo sustituye un pod nuevo. Los logs de este pod se pierden.',
            mirror: 'El kubelet del nodo {node} ejecuta este pod estático desde un fichero y lo vuelve a crear enseguida: eliminarlo aquí no lo detiene.',
            unowned: 'Ningún controlador lo vuelve a crear: el pod y lo que ejecuta desaparecen para siempre.',
            confirm: 'Eliminar pod',
            done: 'Se está eliminando el pod {name}.',
            failed: 'No se pudo eliminar el pod {name}.'
        }
    },
    container: {
        label: 'Contenedor {name}',
        init: 'inicio',
        sidecar: 'sidecar',
        ready: 'Listo',
        notReady: 'No listo',
        restarts: '{count} reinicios',
        restartsOne: '1 reinicio',
        state: 'Estado',
        lastState: 'Último estado',
        exitCode: 'código de salida {code}',
        signal: 'señal {signal}',
        ports: 'Puertos',
        requests: 'Peticiones',
        limits: 'Límites',
        command: 'Comando',
        states: {
            running: 'En marcha',
            waiting: 'En espera',
            terminated: 'Terminado',
            unknown: 'Desconocido'
        }
    },
    env: {
        title: 'Entorno',
        empty: 'La especificación del pod no define variables de entorno.',
        hint: 'Los valores están ocultos hasta que los muestres. Las referencias a secretos nunca se leen.',
        showAll: 'Mostrar todo',
        hideAll: 'Ocultar todo',
        show: 'Mostrar {name}',
        hide: 'Ocultar {name}',
        copy: 'Copiar el valor de {name}',
        copied: 'Valor de {name} copiado.',
        copyFailed: 'No se pudo copiar el valor.',
        masked: 'valor oculto',
        from: 'desde {source}',
        envFrom: 'Además, todas las claves de: {sources}'
    },
    shell: {
        open: 'Shell',
        openIn: 'Abrir un shell en {name}',
        choose: 'Elegir el contenedor',
        inContainer: 'Shell en {name}',
        inInitContainer: 'Shell en {name} (contenedor de inicio)',
        notRunning: 'El pod no tiene ningún contenedor en marcha donde abrir un shell.',
        terminating: 'Se está eliminando el pod.',
        noRunningContainer: 'Ninguno de sus contenedores está en marcha.',
        containerNotRunning: '{name} no está en marcha ({state}).'
    },
    logs: {
        container: 'Contenedor',
        tail: 'Líneas anteriores',
        previous: 'Instancia anterior',
        noPrevious: 'El contenedor no se ha reiniciado: no hay instancia anterior.',
        follow: 'Seguir',
        followPrevious: 'La instancia anterior ya ha terminado: no hay nada que seguir.',
        timestamps: 'Marcas de tiempo',
        start: 'Ver logs',
        stop: 'Detener',
        pause: 'Pausar',
        resume: 'Reanudar',
        stick: 'Quedarse al final',
        clear: 'Limpiar',
        download: 'Descargar',
        filter: 'Filtrar líneas',
        askAi: 'Preguntar a la IA por {name} y sus logs',
        outputLabel: 'Logs de {name}',
        count: '{count} líneas',
        countOne: '1 línea',
        countFiltered: '{shown} de {total} líneas',
        pausedCount: 'En pausa: {count} líneas nuevas esperando',
        discarded: 'Se han descartado {count} líneas antiguas para no pasar del límite',
        dropped: 'Se han omitido {size} porque la vista no daba abasto',
        waiting: 'Esperando líneas de log…',
        idle: 'Elige las opciones de arriba y muestra los logs.',
        noLines: 'No hay líneas de log.',
        backendLost: 'Se ha perdido la conexión con ShellMind.',
        status: {
            idle: 'Sin iniciar',
            connecting: 'Conectando',
            streaming: 'En directo',
            ended: 'Terminado',
            error: 'Fallido',
            endedCode: 'Terminado (código {code})'
        }
    },
    events: {
        label: 'Eventos',
        search: 'Buscar eventos',
        filterLabel: 'Mostrar eventos',
        filter: {
            all: 'Todos',
            warnings: 'Avisos'
        },
        warning: 'Aviso:',
        normal: 'Evento:',
        countAgo: '×{count} · hace {age}',
        openPod: 'Abrir el pod {name}',
        empty: 'No hay eventos',
        emptyHint: 'Kubernetes guarda los eventos durante una hora, más o menos.'
    },
    nodes: {
        caption: '{count} nodos',
        captionOne: '1 nodo',
        empty: 'No hay nodos (o no tienes permiso para listarlos)',
        columns: {
            name: 'Nombre',
            status: 'Estado',
            version: 'Versión',
            capacity: 'Capacidad',
            age: 'Edad',
            actions: 'Acciones'
        },
        ready: 'Listo',
        notReady: 'No listo',
        unknown: 'Desconocido',
        cordoned: 'planificación desactivada',
        worker: 'worker',
        pods: '{count} pods listados',
        podsOne: '1 pod listado',
        capacity: '{cpu} CPU · {memory}',
        cordon: {
            action: 'Acordonar',
            title: '¿Acordonar el nodo {name}?',
            message: 'No se planificarán pods nuevos en {name} hasta que se desacordone. Los pods que ya se ejecutan ahí siguen en marcha (acordonar no vacía el nodo).',
            confirm: 'Acordonar',
            done: '{name} está acordonado.',
            failed: 'No se pudo acordonar {name}.'
        },
        uncordon: {
            action: 'Desacordonar',
            title: '¿Desacordonar el nodo {name}?',
            message: 'Se podrán volver a planificar pods nuevos en {name}.',
            confirm: 'Desacordonar',
            done: '{name} vuelve a aceptar pods nuevos.',
            failed: 'No se pudo desacordonar {name}.'
        }
    },
    errors: {
        K8S_AUTH_REQUIRED: 'El clúster pide que vuelvas a iniciar sesión.',
        K8S_FORBIDDEN: 'No tienes permiso para hacer esto en el clúster.',
        K8S_CONTEXT_NOT_FOUND: 'El kubeconfig ya no tiene este contexto. Vuelve a comprobarlo.',
        K8S_NOT_FOUND: 'Ya no existe en el clúster.',
        K8S_UNREACHABLE: 'No se puede acceder al clúster.',
        K8S_TIMEOUT: 'kubectl no ha respondido a tiempo.',
        K8S_COMMAND_FAILED: 'kubectl ha devuelto un error.',
        K8S_INVALID_INPUT: 'Ese nombre no es válido.',
        K8S_UNSUPPORTED: 'Kubernetes no está disponible para esta conexión.',
        K8S_UNAVAILABLE: 'kubectl no tiene aquí un kubeconfig que se pueda usar.',
        K8S_CONTAINER_NOT_RUNNING: 'El contenedor no está en marcha.',
        KUBECTL_MISSING: 'kubectl no está instalado aquí.'
    },
    terminal: {
        tabName: 'pod: {pod}/{container}',
        connecting: 'Abriendo un shell en {container} del pod {pod} ({namespace}, contexto {context})…'
    },
    ai: {
        attachment: 'Pod {namespace}/{name}',
        prompt: '¿Qué le pasa al pod {name} de {namespace} y cómo lo soluciono?',
        sections: {
            pod: 'Estado del pod',
            'pod-events': 'Eventos del pod',
            'pod-logs': 'Logs del contenedor (últimas 200 líneas)',
            'pod-previous-logs': 'Logs de la instancia anterior'
        }
    }
};

export default es;
