import type en from '../en/multiexec';

const es: typeof en = {
    title: 'Ejecución múltiple',
    jobsAction: 'Trabajos de ejecución múltiple',
    subtitle: 'Ejecuta un comando en muchos servidores SSH como trabajo en segundo plano: todos a la vez o por lotes, con un canario primero.',
    loading: 'Cargando…',
    loadFailed: 'No se han podido cargar los servidores: {error}',
    tabs: {
        label: 'Ejecución múltiple',
        new: 'Nuevo trabajo',
        jobs: 'Trabajos',
        running: '{count} en curso'
    },
    targets: {
        title: 'Servidores',
        selected: 'Seleccionados: {count}',
        search: 'Buscar servidores',
        group: 'Grupo',
        allGroups: 'Todos los grupos',
        noGroup: 'Sin grupo',
        tag: 'Etiqueta',
        allTags: 'Todas las etiquetas',
        selectVisible: 'Seleccionar los mostrados ({count})',
        clear: 'Quitar',
        noMatch: 'Ningún servidor coincide con estos filtros.',
        none: 'No hay servidores SSH guardados (la ejecución múltiple funciona en servidores Linux y Windows).',
        hiddenSelected: 'También seleccionados, ocultos por los filtros: {count}'
    },
    compose: {
        source: 'Origen del comando',
        command: 'Comando',
        snippet: 'Snippet',
        commandLabel: 'Comando',
        commandHint: 'Se ejecuta sin terminal interactivo: fallan los comandos que piden datos, como sudo con contraseña. Los marcadores {{name}} se piden antes de ejecutarlo.',
        fromSnippet: 'Del snippet «{name}».',
        snippetLabel: 'Snippet',
        chooseSnippet: 'Elige un snippet…',
        noSnippets: 'Todavía no hay snippets guardados',
        timeout: 'Tiempo límite por servidor (segundos)',
        timeoutHint: 'Incluida la conexión. El comando se detiene si tarda más.',
        concurrency: 'Servidores en paralelo',
        concurrencyHint: 'Cuántos servidores lo ejecutan a la vez.',
        secretsHidden: 'Los valores secretos se ocultan aquí. Solo se envían a los servidores: el registro de auditoría y el historial de trabajos guardan su {{placeholder}}.',
        rerunNote: 'Se vuelve a ejecutar el trabajo en los servidores donde no salió bien.',
        maskedHistory: 'Partes de este comando se ocultaron en el historial porque parecían secretos. Vuelve a escribirlas antes de ejecutarlo.',
        showRunning: 'Ver el trabajo en curso',
        needTargets: 'Selecciona al menos un servidor.',
        tooManyTargets: 'Selecciona como máximo {max} servidores.',
        needSnippet: 'Elige un snippet.',
        snippetScoped: '«{name}» solo está disponible en {server}: selecciona solo ese servidor o elige otro snippet.',
        needCommand: 'Escribe un comando.',
        commandTooLong: 'El comando puede tener como máximo {max} caracteres una vez rellenado.',
        badTimeout: 'El tiempo límite debe ser un número entero de segundos entre 1 y {max}.',
        badConcurrency: 'Los servidores en paralelo deben ser un número entero entre 1 y {max}.',
        review: 'Revisar'
    },
    strategy: {
        title: 'Despliegue',
        mode: 'Despliegue',
        parallel: 'Todos a la vez',
        parallelHint: 'Lo ejecutan todos los servidores, unos pocos a la vez.',
        rolling: 'Por lotes',
        rollingHint: 'Un lote cada vez: el siguiente empieza cuando termina el anterior.',
        batchSize: 'Tamaño del lote',
        batchUnit: 'Unidad del tamaño del lote',
        unitPercent: '%',
        unitServers: 'servidores',
        pause: 'Pausa entre lotes (s)',
        canary: 'Empezar con un canario',
        canaryHint: 'Unos pocos servidores lo ejecutan primero; el resto espera a que terminen.',
        canaryCount: 'Servidores canario',
        canaryThen: 'Después',
        thenPause: 'Esperar a mi aprobación',
        thenPauseHint: 'El trabajo se pausa tras el canario hasta que lo continúes.',
        thenContinue: 'Seguir si todos salen bien',
        thenContinueHint: 'Si el canario falla, igualmente espera a que decidas.',
        failureLimit: 'Detener tras fallos',
        failureLimitHint: 'No se inician más servidores cuando fallan o agotan el tiempo estos tantos; los que estén en curso terminan.',
        failureCount: 'Servidores con fallo',
        failurePercent: 'o % de servidores',
        badBatchSize: 'El tamaño del lote debe ser un número entero de servidores entre 1 y {max}.',
        badBatchPercent: 'El tamaño del lote debe ser un porcentaje entre 1 y {max}.',
        badPause: 'La pausa entre lotes debe ser un número entero de segundos entre 0 y {max}.',
        canaryNeedsTwo: 'Un canario necesita al menos dos servidores seleccionados.',
        badCanary: 'El canario debe ser un número entero de servidores entre 1 y {max} (menos que los seleccionados).',
        needFailureLimit: 'Indica cuántos fallos (o qué porcentaje) detienen el trabajo.',
        badFailureCount: 'El número de fallos debe ser un número entero entre 1 y {max}.',
        badFailurePercent: 'El porcentaje de fallos debe ser un número entero entre 1 y 100.'
    },
    plan: {
        title: 'Plan',
        batchesLabel: 'Lotes',
        canaryName: 'Canario',
        canaryShort: 'C · {count}',
        batchName: 'Lote {number}',
        servers: {
            one: '1 servidor',
            other: '{count} servidores'
        },
        state: {
            pending: 'en espera',
            current: 'en curso',
            done: 'terminado',
            failed: 'con fallos',
            skipped: 'no ejecutado'
        },
        canary: {
            one: 'Canario: primero 1 servidor y después {then}.',
            other: 'Canario: primero {count} servidores y después {then}.'
        },
        thenApprove: 'espera a tu aprobación',
        thenContinue: 'sigue si todos salen bien',
        thenWaitContinue: 'espera {seconds} s y sigue si todos salen bien',
        allAtOnce: {
            one: 'Se ejecuta en 1 servidor.',
            other: 'Los {count} servidores, hasta {concurrency} a la vez.'
        },
        restAtOnce: {
            one: 'Después, el servidor restante.',
            other: 'Después, los {count} servidores restantes, hasta {concurrency} a la vez.'
        },
        batches: {
            one: '{batches} lotes de 1 servidor cada uno.',
            other: '{batches} lotes de hasta {size} servidores, hasta {concurrency} a la vez.'
        },
        pause: '{seconds} s entre lotes.',
        stopAfter: {
            one: 'Se detiene al primer fallo.',
            other: 'Se detiene tras {count} fallos.'
        },
        stopAfterPercent: 'Se detiene cuando ha fallado el {percent} % de los servidores.',
        stopAfterBoth: {
            one: 'Se detiene al primer fallo o cuando haya fallado el {percent} % de los servidores, lo que llegue antes.',
            other: 'Se detiene tras {count} fallos o el {percent} % de los servidores, lo que llegue antes.'
        }
    },
    confirm: {
        title: {
            one: '¿Ejecutar este comando en 1 servidor?',
            other: '¿Ejecutar este comando en {count} servidores?'
        },
        details: 'Cada servidor se detiene a los {timeout} s, hasta {concurrency} a la vez. Todos los comandos quedan en el registro de auditoría, también el hostname que ShellMind ejecuta una vez por conexión para agrupar las salidas iguales. El trabajo sigue aunque cierres esta ventana.',
        command: 'Comando',
        servers: 'Servidores',
        back: 'Atrás',
        run: {
            one: 'Ejecutar en 1 servidor',
            other: 'Ejecutar en {count} servidores'
        }
    },
    danger: {
        title: 'Comando destructivo',
        message: {
            one: 'Este comando {reason} y se ejecutará en 1 servidor. Revísalo con cuidado.',
            other: 'Este comando {reason} y se ejecutará en {count} servidores. Revísalo con cuidado.'
        },
        typeToConfirm: 'Escribe {count} (el número de servidores) para confirmar:',
        reasons: {
            recursiveDelete: 'borra archivos de forma recursiva',
            disk: 'escribe en un disco o lo formatea',
            power: 'apaga o reinicia la máquina',
            forkBomb: 'puede agotar los recursos de la máquina (fork bomb)',
            permissions: 'cambia el propietario o los permisos de todo el sistema',
            database: 'borra datos de una base de datos',
            firewall: 'restablece las reglas del cortafuegos',
            cloudDelete: 'elimina recursos en la nube',
            containerData: 'borra datos de contenedores',
            processes: 'mata todos los procesos',
            scheduler: 'borra las tareas programadas',
            remoteCode: 'descarga un script de internet y lo ejecuta',
            backdoor: 'abre acceso remoto o envía datos fuera de la máquina',
            overwrite: 'sobrescribe un archivo crítico del sistema'
        }
    },
    status: {
        queued: 'En cola',
        running: 'En curso',
        ok: 'Correcto',
        failed: 'Error',
        timeout: 'Tiempo agotado',
        cancelled: 'Cancelado',
        skipped: 'No ejecutado'
    },
    jobStatus: {
        running: 'En curso',
        paused: 'En pausa',
        done: 'Terminado',
        doneWithFailures: 'Terminado con fallos',
        stopped: 'Detenido',
        cancelled: 'Cancelado',
        interrupted: 'Interrumpido'
    },
    job: {
        title: 'Trabajo',
        pause: 'Pausar',
        resume: 'Reanudar',
        cancel: 'Cancelar trabajo',
        batchOf: 'Lote {number} de {total}',
        canaryRunning: 'Canario',
        pausedProgress: 'En pausa · {done} de {total} terminados',
        stopping: 'Deteniendo: se alcanzó el límite de fallos; los servidores en curso terminan.',
        doneWithFailures: 'Terminado · correctos: {ok}, con error: {failed}',
        stopped: {
            'failure-limit': {
                one: 'Detenido por el límite de fallos ({failed} con error); 1 servidor no llegó a ejecutarlo.',
                other: 'Detenido por el límite de fallos ({failed} con error); {count} servidores no llegaron a ejecutarlo.'
            },
            'pause-timeout': {
                one: 'Detenido: nadie lo reanudó a tiempo; 1 servidor no llegó a ejecutarlo.',
                other: 'Detenido: nadie lo reanudó a tiempo; {count} servidores no llegaron a ejecutarlo.'
            },
            lifetime: 'Detenido: el trabajo duró demasiado.'
        },
        interrupted: 'Interrumpido: ShellMind se cerró mientras el trabajo estaba en curso.',
        reconnecting: 'Se perdió la conexión con el trabajo: reconectando…',
        rerunOf: 'Repetición de un trabajo anterior'
    },
    gate: {
        canaryOk: {
            one: 'Canario terminado: {ok} de {total} sin errores. ¿Continuar con el servidor restante?',
            other: 'Canario terminado: {ok} de {total} sin errores. ¿Continuar con los {count} servidores restantes?'
        },
        canaryFailed: {
            one: 'El servidor canario falló. Revisa su resultado y continúa igualmente o cancela el trabajo.',
            other: 'El canario falló en {failed} de {count} servidores. Revisa los resultados y continúa igualmente o cancela el trabajo.'
        },
        paused: 'En pausa: no se inician servidores nuevos; los que están en curso terminan.',
        expires: 'El trabajo se detiene si no se continúa en {time}.',
        continue: 'Continuar',
        continueAnyway: 'Continuar igualmente',
        limitReached: 'Límite de fallos alcanzado: no se inician más servidores.',
        nextBatch: 'Siguiente lote en {time}'
    },
    filter: {
        label: 'Filtrar por estado',
        all: 'Todos',
        problems: 'Sin éxito'
    },
    groups: {
        title: 'Resultados por salida',
        normalize: 'Ignorar nombres de host, horas y PID',
        summary: '{identical}, {different}',
        identical: {
            one: '1 idéntico',
            other: '{count} idénticos'
        },
        different: {
            one: '1 distinto',
            other: '{count} distintos'
        },
        allSame: 'Los {count} mostraron lo mismo',
        oneServer: '1 servidor terminado',
        without: '{count} sin salida',
        pending: '{count} en curso o en cola',
        nothingYet: 'Aún no ha terminado ningún servidor.',
        majority: 'Grupo A · salida más común',
        variant: 'Grupo {letter} · salida distinta',
        label: 'Grupo {letter}',
        servers: {
            one: '1 servidor',
            other: '{count} servidores'
        },
        members: 'Servidores de este grupo',
        more: 'y {count} más',
        fewer: 'mostrar menos',
        compare: 'Comparar con {letter}',
        none: {
            queued: 'En cola',
            running: 'En curso',
            ok: 'Sin salida',
            failed: 'Error sin salida',
            timeout: 'Tiempo agotado',
            cancelled: 'Cancelado antes de ejecutarse',
            skipped: 'No ejecutado (el trabajo se detuvo antes)'
        }
    },
    diff: {
        label: 'Diferencias entre {base} y {other}',
        summary: '{added}, {removed}',
        linesAdded: {
            one: '1 línea añadida',
            other: '{count} líneas añadidas'
        },
        linesRemoved: {
            one: '1 quitada',
            other: '{count} quitadas'
        },
        add: 'añadida',
        remove: 'quitada',
        equal: 'sin cambios',
        sameText: 'La salida es la misma; cambia el código de salida o el estado.',
        sameKept: 'Las partes guardadas en el historial son idénticas: la diferencia está más adelante.',
        trimmed: 'El historial solo guarda el principio de cada salida.',
        coarse: 'Las salidas son demasiado distintas para compararlas línea a línea: se muestra entera la parte que cambia.',
        moreHunks: {
            one: 'Otro fragmento con cambios sin mostrar.',
            other: '{count} fragmentos más con cambios sin mostrar.'
        }
    },
    results: {
        show: 'Mostrar resultados',
        grouped: 'Por salida',
        byServer: 'Por servidor',
        progress: 'Ejecutando… {done} de {total} terminados',
        finished: {
            one: 'Terminado en 1 servidor',
            other: 'Terminado en {count} servidores'
        },
        cancelledRun: 'Trabajo cancelado',
        servers: 'Resultados por servidor',
        noneMatch: 'Ningún servidor coincide con este filtro.',
        expandAll: 'Desplegar todo',
        collapseAll: 'Plegar todo',
        exitCode: 'Código de salida',
        exit: 'salida {code}',
        duration: 'Duración',
        copyOutput: 'Copiar la salida de {server}',
        outputCopied: 'Salida copiada',
        copyFailed: 'El portapapeles no está disponible',
        truncated: 'Salida recortada: solo se guardaron los primeros 256 KB.',
        trimmed: 'El historial solo guarda los primeros 64 KB de la salida.',
        noOutput: 'Sin salida.',
        skipped: 'No ejecutado: el trabajo se detuvo antes de llegar a este servidor.',
        waiting: 'Esperando la salida…',
        exportJson: 'JSON',
        exportCsv: 'CSV',
        exportText: 'Texto',
        auditLog: 'Registro de auditoría',
        rerunFailed: 'Repetir donde falló ({count})',
        rerunUnfinished: 'Repetir donde no salió bien ({count})',
        mayHaveRun: {
            one: 'Fuera de «Repetir»: 1 servidor donde el trabajo se cortó mientras el comando se ejecutaba. Puede que ya se haya ejecutado ahí; crea un trabajo nuevo para incluirlo.',
            other: 'Fuera de «Repetir»: {count} servidores donde el trabajo se cortó mientras el comando se ejecutaba. Puede que ya se haya ejecutado ahí; crea un trabajo nuevo para incluirlos.'
        },
        newRun: 'Nuevo trabajo a partir de este'
    },
    jobs: {
        running: 'En curso',
        finished: 'Historial',
        all: 'Todos los trabajos',
        new: 'Nuevo trabajo',
        empty: 'Todavía no hay trabajos',
        emptyHint: 'Los trabajos que ejecutes aparecen aquí con sus resultados y se conservan al cerrar la ventana.',
        loadFailed: 'No se ha podido cargar el historial de trabajos: {error}',
        servers: {
            one: '1 servidor',
            other: '{count} servidores'
        },
        outcome: '{ok} OK · {failed} con error',
        progress: '{done} de {total} terminados',
        delete: 'Borrar del historial',
        deleteRunning: 'Cancela el trabajo antes de borrarlo',
        deleteTitle: '¿Borrar este trabajo?',
        deleteMessage: 'Sus resultados y salidas se borran del historial. El registro de auditoría conserva sus entradas.',
        clear: 'Vaciar historial',
        clearTitle: '¿Vaciar el historial de trabajos?',
        clearMessage: 'Se borran todos los trabajos terminados y sus salidas. Se conservan los trabajos en curso y el registro de auditoría.',
        cleared: 'Trabajos borrados del historial: {count}',
        loadMore: 'Ver trabajos anteriores',
        loadMoreFailed: 'No se han podido cargar los trabajos anteriores: {error}'
    },
    notify: {
        done: {
            one: 'Trabajo de ejecución múltiple terminado: 1 correcto',
            other: 'Trabajo de ejecución múltiple terminado: {count} correctos'
        },
        doneWithFailures: 'Trabajo de ejecución múltiple terminado · correctos: {ok}, con error: {failed}',
        stopped: {
            'failure-limit': 'Trabajo de ejecución múltiple detenido por su límite de fallos ({failed} con error)',
            'pause-timeout': 'Trabajo de ejecución múltiple detenido: no se continuó a tiempo',
            lifetime: 'Trabajo de ejecución múltiple detenido: duró demasiado'
        },
        cancelled: 'Trabajo de ejecución múltiple cancelado',
        interrupted: 'Trabajo de ejecución múltiple interrumpido',
        canaryOk: 'Canario correcto: el trabajo de ejecución múltiple espera tu aprobación',
        canaryFailed: 'El canario falló: el trabajo de ejecución múltiple espera a que decidas'
    },
    errors: {
        noStream: 'El backend no devolvió el flujo de eventos.',
        busy: 'Hay demasiados trabajos de ejecución múltiple en curso. Espera a que termine alguno y vuelve a intentarlo.',
        closing: 'ShellMind se está cerrando: el trabajo no se ha iniciado.',
        dangerous: 'El backend rechazó el comando destructivo porque no se había confirmado. Vuelve a revisarlo.',
        missing: 'Estos servidores ya no existen: {list}. Vuelve a abrir la ejecución múltiple para recargar la lista.',
        unsupported: 'La ejecución múltiple solo funciona en servidores SSH (Linux y Windows): {list}.',
        rejected: 'El backend no aceptó el trabajo: {error}',
        finished: 'El trabajo ya ha terminado.',
        notFound: 'Este trabajo ya no existe (se borró del historial).',
        active: 'Cancela el trabajo antes de borrarlo.',
        pauseFailed: 'No se ha podido pausar el trabajo',
        resumeFailed: 'No se ha podido reanudar el trabajo',
        cancelFailed: 'No se ha podido cancelar el trabajo',
        deleteFailed: 'No se ha podido borrar el trabajo'
    },
    serverErrors: {
        TIMEOUT: 'El comando no terminó en {seconds} s y se detuvo.',
        CONNECT_TIMEOUT: 'No se pudo conectar en {seconds} s; el comando no llegó a ejecutarse.',
        HANDSHAKE_TIMEOUT: 'El servidor no completó la negociación SSH a tiempo.',
        SIGNAL: 'La señal {signal} terminó el comando.',
        NO_EXIT_STATUS: 'El servidor no informó del código de salida.',
        AUTH_FAILED: 'Error de autenticación: el servidor rechazó las credenciales guardadas.',
        HOST_KEY_MISMATCH: 'La clave del servidor ha cambiado desde que se confió en ella. Revísala en Hosts conocidos antes de volver a conectar.',
        CONNECTION_REFUSED: 'El servidor rechazó la conexión. ¿Está SSH escuchando en ese puerto?',
        HOST_NOT_FOUND: 'No se pudo resolver el nombre del host.',
        HOST_UNREACHABLE: 'No se pudo llegar al host.',
        INTERRUPTED: 'ShellMind se cerró (o su backend se detuvo) mientras el comando estaba en curso: puede haberse ejecutado entero o en parte.'
    },
    export: {
        title: 'Resultados de ejecución múltiple de ShellMind',
        command: 'Comando',
        started: 'Inicio',
        status: 'Estado',
        servers: 'Servidores',
        exit: 'salida {code}',
        error: 'Error'
    }
};

export default es;
