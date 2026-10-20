// Italian message dictionary for the shared UI.
//
// Translation of `../i18n.ts`, key for key: every English key has exactly one Italian
// entry with identical `{placeholders}`. Missing keys fall back to English at
// lookup time, so this table must never drop a key when English grows.
// Brand and product names ("Dezoomify", "Chrome Web Store", "GitHub Releases",
// "GPL", "PNG", "JPEG", "URL", "CLI", "FAQ") stay literal.
//
// Erasable-syntax-only TypeScript (plain object, no enums) so node can
// type-strip it directly in tests.

export const it = {
  "view.images.title": "Scegli un’immagine",
  "view.images.untitled": "Immagine {number}",
  "view.images.noPreview": "Anteprima non disponibile",
  "view.images.unknownSize": "Dimensioni sconosciute",
  "view.images.choose": "Scegli",
  "view.images.chooseNamed": "Scegli {title} (immagine {number})",
  "view.images.cancel": "Annulla",
  "page.brand": "Salva immagini zoomabili",
  "page.nav.label": "Navigazione principale",
  "page.nav.extension": "Estensione del browser",
  "page.nav.desktop": "Applicazione desktop",
  "page.nav.help": "Aiuto",
  "page.nav.donate": "Fai una donazione",
  "page.nav.donateTitle": "Contribuisci ai costi di hosting",
  "page.footer.source": "Codice sorgente (GPL)",
  "page.footer.faq": "Domande frequenti",
  "page.footer.privacy": "Privacy",
  "page.footer.terms": "Condizioni d’uso",
  "page.legacy.title": "Cerchi il vecchio Dezoomify?",
  "page.legacy.link": "Apri la versione precedente",
  "page.preview.zoomOut": "Riduci zoom",
  "page.preview.zoomIn": "Aumenta zoom",
  "page.preview.reset": "Ripristina lo zoom al 100 per cento",
  "page.preview.fit": "Adatta",
  "page.preview.fitLabel": "Adatta l’immagine all’anteprima",
  "view.diagnostics.signedInNote":
    "Se questo sito richiede l'accesso, questi dettagli potrebbero contenere informazioni sensibili. Controllali prima di condividerli.",
  "view.diagnostics.save": "Salva il rapporto diagnostico",
  "view.diagnostics.copyFailed": "Copia non riuscita. Seleziona e copia i dettagli qui sotto.",
  "view.diagnostics.loadFailed":
    "Impossibile leggere il rapporto completo. I dettagli disponibili sono mostrati qui sotto.",
  "view.retry.title": "Download in pausa",
  "view.retry.summary": "Sono stati recuperati {done} frammenti su {total}.",
  "view.retry.explanation":
    "I tentativi automatici sono esauriti. Riprova o annulla; nessun file è stato salvato.",
  "view.retry.retry": "Riprova una volta",
  "view.retry.cancel": "Annulla",
  "desktop.done.title": "Immagine salvata",
  "desktop.done.size": "{width} × {height} pixel",
  "desktop.done.saved": "Salvata nella cartella scelta.",
  "desktop.done.open": "Apri immagine",
  "desktop.done.reveal": "Mostra nella cartella",
  "desktop.done.openError":
    "Impossibile aprire l’immagine. Verifica che sia installato un visualizzatore predefinito.",
  "desktop.done.folderError":
    "Impossibile aprire la cartella. Verifica che sia installato un gestore di file.",
  "desktop.done.missingError": "L’immagine o la cartella non esiste più.",
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Capito",
  "view.modal.closeDialog": "Chiudi la finestra",
  "view.modal.closeTitle": "Chiudi",
  // Desktop-app guidance modal.
  "view.desktop.title": "Applicazione desktop Dezoomify",
  "view.desktop.download.windows": "Programma di installazione Windows · x64 (MSI)",
  "view.desktop.download.macos": "Programma di installazione macOS · Apple Silicon (DMG)",
  "view.desktop.download.linux": "Programma di installazione Linux · x64 (DEB)",
  "view.desktop.step1":
    "Scarica il programma di installazione qui sopra per il tuo sistema, poi installalo.",
  "view.desktop.subtitle": "Salva immagini di grandi dimensioni direttamente sul tuo computer",
  "view.desktop.whyTitle": "Perché usare l’applicazione desktop?",
  "view.desktop.why1Title": "Scarica immagini più grandi:",
  "view.desktop.why1Body":
    "Salva immagini che superano i limiti di dimensione del browser. L’applicazione può costruire il file durante il download, senza tenere l’intera immagine in memoria. Per immagini molto grandi potrebbe comunque servire un altro formato o una dimensione ridotta.",
  "view.desktop.why2Title": "Usa la tua connessione:",
  "view.desktop.why2Body":
    "L’applicazione scarica le informazioni sull’immagine e ogni suo frammento direttamente dal sito di origine usando la tua connessione internet. Può essere utile quando un sito blocca il server condiviso di Dezoomify.",
  "view.desktop.why3Title": "Scegli il formato del file:",
  "view.desktop.why3Body":
    "Salva in JPEG, PNG, TIFF o altri formati per visualizzare, modificare o archiviare le immagini. Scegli la cartella in cui salvarle.",
  "view.desktop.howTitle": "Come usarla",
  "view.desktop.step2":
    "Apri Dezoomify e incolla l’indirizzo della pagina o dell’immagine zoomabile.",
  "view.desktop.step3":
    "Scegli una cartella, un formato e una dimensione dell’immagine, poi avvia il download.",
  "view.desktop.cliTitle": "Serve automazione? Prova Dezoomify CLI",
  "view.desktop.cliDesc":
    "Usa la versione a riga di comando per scaricare immagini tramite script o elaborare un elenco di indirizzi.",
  "view.desktop.cliLink": "Scarica il CLI da GitHub Releases",
  // Browser-extension guidance modal.
  "view.ext.title": "Estensione del browser Dezoomify",
  "view.ext.subtitle":
    "Salva immagini zoomabili dalla pagina che stai visualizzando, anche dai siti a cui hai effettuato l’accesso",
  "view.ext.availableOn": "Disponibile su",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxStore": "Firefox Browser Add-ons",
  "view.ext.whyTitle": "Perché usare l’estensione del browser?",
  "view.ext.why1Title": "Usa l’accesso già effettuato:",
  "view.ext.why1Body":
    "Scarica le immagini a cui puoi accedere dopo aver effettuato l’accesso a una biblioteca, un museo o un archivio. Se serve accedere a un altro sito, l’estensione ti chiede il permesso.",
  "view.ext.why2Title": "Trova l’immagine senza cercarne l’indirizzo:",
  "view.ext.why2Body":
    "Fai clic su Dezoomify nella barra del browser per trovare l’immagine nel visualizzatore della pagina. Il download parte in una nuova scheda. I limiti di dimensione del browser restano validi.",
  "view.ext.why3Title": "Si avvia quando lo chiedi:",
  "view.ext.why3Body":
    "L’estensione controlla la pagina solo quando fai clic sul suo pulsante. Non osserva la tua navigazione in background.",
  "view.ext.howTitle": "Come usarla in 3 passi",
  "view.ext.step1": "Installa l’estensione dal Chrome Web Store o da Firefox Browser Add-ons.",
  "view.ext.step2":
    "Apri la pagina con la tua immagine, accedi se necessario e ingrandisci una volta per lasciare caricare l’immagine.",
  "view.ext.step3":
    "Fai clic su Dezoomify nella barra del browser. Consenti l’accesso se richiesto e lascia aperta la scheda del download fino al termine del salvataggio.",
  // Access request (browser-session file access), shared access-request.tsx.
  "view.access.title": "Consenti l’accesso per continuare",
  "view.access.usesOrigin": "Questa immagine usa file di {origin}.",
  "view.access.needAccess":
    "Dezoomify ha bisogno di accesso per leggere quei file e comporre la tua immagine in questo browser.",
  "view.access.requesting": "Richiesta di accesso in corso…",
  "view.access.allow": "Consenti l’accesso e continua",
  // Idle input section.
  "view.idle.clearTitle": "Cancella il testo",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Ricerca dell’immagine zoomabile…",
  "view.step.preflighting": "Controllo delle dimensioni…",
  "view.step.downloading": "Scaricamento dei frammenti…",
  "view.step.saving": "Composizione dell’immagine finale…",
  "view.step.contactingDetail": "Connessione al sito di origine…",
  // Live job section.
  "view.job.techDetails": "Dettagli tecnici e registri",
  "view.job.manyImages": "{count} immagini",
  "view.job.paused": "In pausa",
  "view.job.retryingTiles": "Nuovo tentativo per {count} frammenti…",
  "view.job.waiting": "In attesa di {host}…",
  "view.job.sourceLabel": "Sorgente",
  "view.job.pause": "Pausa",
  "view.job.resume": "Riprendi",
  "view.job.stopReturn": "Ferma e torna all’inizio",
  "view.job.progressValue": "{done} completati, {active} in corso, {remaining} rimanenti",
  // Display-only section.
  "view.display.title": "Anteprima mostrata, non ancora salvata",
  "view.display.waysTitle": "Modi per salvare quest’opera",
  "view.display.extTitle": "Guida all’estensione del browser",
  "view.display.extDesc":
    "Trova l’immagine nella pagina che stai visualizzando, anche dove hai effettuato l’accesso.",
  "view.display.deskTitle": "Guida all’applicazione desktop",
  "view.display.deskDescClean":
    "Scarica direttamente dal sito di origine quando il browser può mostrare solo un’anteprima.",
  "view.display.startOver": "Ricomincia",
  "view.resolution.title": "Immagine a risoluzione ridotta",
  "view.resolution.sizes":
    "Dimensioni dell’immagine: {selected} pixel. Massimo disponibile: {maximum} pixel.",
  "view.resolution.download": "Ottieni la risoluzione completa con l’applicazione desktop",
  "view.desktop.handoffTitle": "Scarica questa immagine nell’applicazione desktop",
  "view.desktop.handoffInstall":
    "Scegli l’installer per il tuo sistema operativo, poi apri Dezoomify.",
  "view.desktop.handoffPaste": "Incolla questo indirizzo nell’applicazione desktop:",
  "view.desktop.handoffCopy": "Copia indirizzo",
  "view.desktop.handoffCopied": "Indirizzo copiato. Incollalo nell’applicazione desktop.",
  "view.desktop.handoffCopyFailed":
    "Copia non riuscita. Seleziona l’indirizzo qui sopra e copialo manualmente.",
  "view.desktop.handoffStart":
    "Scegli Risoluzione completa nel menu Dimensione, poi avvia il download.",
  "view.desktop.handoffAccess":
    "L’applicazione desktop non può usare l’accesso effettuato nel browser. Per le immagini che richiedono l’accesso, prova l’estensione del browser.",
  "view.desktop.handoffUnavailable":
    "Non c’è un indirizzo dell’immagine da copiare per questo download. Copia l’indirizzo della pagina originale e provalo nell’applicazione desktop.",
  // Completion section.
  "view.done.ready": "La tua immagine è pronta.",
  "view.done.readyTitle": "Pronta da salvare",
  "view.done.saveNow": "Salva ora l’immagine",
  "view.done.another": "Dezoomifica un’altra immagine",
  "view.done.guidance":
    "Usa il pulsante di salvataggio per scaricare la tua immagine. I colori possono variare leggermente perché i download dal browser non conservano il profilo colore originale. Per i formati che conservano i profili colore, usa l’applicazione desktop.",
  "view.done.summary": "{width} × {height} pixel ({mime})",
  "view.done.fallback":
    "È stata salvata un’immagine disponibile su questa pagina. Se non è quella che cercavi, puoi segnalarlo tramite i dettagli tecnici qui sotto.",
  "view.display.guidance":
    "Il browser può mostrare questa immagine, ma il sito di origine non gli permette di creare un file scaricabile. Prova l’applicazione desktop o l’estensione del browser per salvarla.",
  // Failure section.
  "view.fail.title": "Impossibile dezoomificare l’immagine",
  "view.fail.deskDescLimits":
    "Salva immagini più grandi o usa la tua connessione quando un sito blocca il nostro server.",
  "view.fail.helpTitle": "Aiuto per trovare un’immagine",
  "view.fail.helpDesc":
    "Come trovare l’indirizzo dell’immagine nei siti di musei e archivi, e cosa provare quando non si trova nulla.",
  "view.fail.reportBug": "Segnala un problema su GitHub",
  "view.fail.reportBugDesc":
    "Prepara una segnalazione su GitHub con la diagnostica di questo tentativo.",
  "view.fail.retry": "Riprova",
  "view.fail.canvasAllocation":
    "Questa immagine è troppo grande per questa scheda del browser. Prova l’applicazione desktop per salvare un’immagine più grande.",
  "view.fail.canvasContext":
    "Il browser non ha potuto preparare un’immagine di queste dimensioni. Prova l’applicazione desktop, oppure chiudi altre schede e riprova.",
  // Cancelled section.
  "view.cancel.title": "Salvataggio annullato",
  "view.cancel.message": "Il salvataggio dell’immagine è stato interrotto.",
  // Job section and share chrome.
  "view.job.countsFull": "{current} frammenti su {total}",
  "view.job.pixelCounts": "{current} su {total}",
  "view.job.pixels": "{count} px",
  "view.job.megapixels": "{count} Mpx",
  "view.job.gigapixels": "{count} Gpx",
  "view.job.preparation": "{percent}% dei pixel preparati. Completamento del salvataggio.",
  "view.job.countsActive": "{current} frammenti su {total} · {active} in corso",
  // Recent pictures, including unsuccessful attempts.
  "view.history.title": "Immagini recenti",
  "view.history.empty": "Ancora nessuna immagine recente. Le immagini avviate appaiono qui.",
  "view.history.localOnly": "Conservate solo su questo dispositivo.",
  "view.history.clear": "Cancella la cronologia",
  "view.history.source": "Fonte",
  "view.history.time": "Avvio",
  "view.history.size": "Dimensioni (px)",
  "view.history.result": "Risultato",
  "view.history.remove": "Rimuovi",
  "view.history.removeImage": "Rimuovi {image} dalle immagini recenti",
  "view.history.status.started": "Avviata",
  "view.history.status.completed": "Completata",
  "view.history.status.preview": "Solo anteprima",
  "view.history.status.failed": "Non riuscita",
  "view.history.status.cancelled": "Annullata",
  "view.history.status.deleted": "Eliminato",
  "view.history.status.checking": "Verifica del file…",
  "view.history.status.unavailable": "File non disponibile",
  "view.history.status.opening": "Apertura…",
  "view.history.openImage": "Apri {image}",
  "view.history.openFailed": "Impossibile aprire il file.",
  "view.input.description":
    "Salva immagini zoomabili da musei, biblioteche, archivi e altri siti web. Incolla l’indirizzo della pagina che mostra la tua immagine per iniziare.",
  "view.input.placeholder": "Incolla l’indirizzo di una pagina o immagine",
  "view.input.aria": "Indirizzo della pagina con l’immagine ingrandibile",
  "view.input.start": "Trova immagine",
  // Rate-limit explainers (see failure.ts plainMessageFor).
  "view.fail.rateProxy":
    "Il sito di origine sta limitando i download dal nostro server. Attendi qualche minuto, oppure prova l’applicazione desktop o l’estensione del browser per scaricare con la tua connessione internet.",
  "view.fail.rateDirect":
    "Il sito di origine sta limitando i download dalla tua connessione. Attendi qualche minuto prima di riprovare. L’applicazione desktop e l’estensione usano la stessa connessione e potrebbero non aiutare.",
  // Fetch-failure family (see failure.ts plainMessageFor).
  "view.fail.httpNotFound": "Questa pagina non è stata trovata. Controlla l’indirizzo e riprova.",
  "view.fail.httpRefused":
    "Il sito ha rifiutato di condividere questo file (HTTP {http}). Potrebbe bloccare i server condivisi; l’estensione del browser o l’app desktop potrebbero comunque funzionare.",
  "view.fail.httpSiteProblem":
    "Il sito ha avuto un problema nell’aprire questa pagina. Riprova a breve.",
  "view.fail.httpNotOpened": "Questa pagina non è stata aperta. Controlla l’indirizzo e riprova.",
  "view.fail.policyBlocked":
    "Questo indirizzo non può essere aperto tramite il sito. {hint} L’estensione del browser o l’app desktop potrebbero comunque funzionare.",
  "view.fail.hintAddress": "Controlla l’indirizzo e riprova.",
  "view.fail.hintPrivate": "Il sito non può aprire indirizzi privati o locali.",
  "view.fail.hintContentType":
    "Il sito di origine ha restituito un tipo di file che Dezoomify non può leggere qui.",
  "view.fail.hintRedirect": "Il sito ha reindirizzato in un modo che il sito non può seguire.",
  "view.fail.proxyBudget":
    "Questo file è troppo grande per essere scaricato dal nostro server. Prova l’applicazione desktop per scaricarlo direttamente.",
  "view.fail.proxyFetch":
    "Il nostro server non ha potuto recuperare questo indirizzo. Riprova tra poco, oppure usa l’applicazione desktop per collegarti direttamente al sito di origine.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid": "Inserisci un indirizzo web valido che inizi con http:// o https://",
  "desktop.settings.unusable":
    "Queste impostazioni di scaricamento non si possono usare. Regola le impostazioni evidenziate e riprova.",
  "desktop.settings.invalidSubmit":
    "Queste impostazioni di scaricamento non sono valide. Regolale e riprova.",
  "desktop.output.deniedPick":
    "La destinazione di salvataggio non è stata accettata. Scegli un altro file per continuare.",
  "desktop.output.exists":
    "Esiste già un file nella destinazione di salvataggio da {host}. Scegli un altro file o conferma la sovrascrittura per continuare.",
  "desktop.output.destDenied":
    "La destinazione di salvataggio non è stata accettata da {host}. Scegli un altro file per continuare.",
  "desktop.job.gone":
    "Questa attività non è più attiva da {host}. Ricomincia con un indirizzo nuovo.",
  "desktop.msg.thisPicture": "questa immagine",
  "desktop.msg.dimsPixels": "{a} per {b} pixel",
  "desktop.msg.needAbout": " Serve circa {need} di memoria",
  "desktop.output.canvasLimit":
    "Questa immagine richiede più memoria di quella disponibile ({dims},{need}; limite {limit}). Salva una versione più piccola con Larghezza max (CLI: --max-width), oppure scegli una cartella di tessere. Da {host}.",
  "desktop.tile.failed":
    "Impossibile recuperare un frammento da {host}. Controlla l’immagine originale e riprova.",
  "view.discovery.none":
    "Nessuna immagine zoomabile trovata a questo indirizzo. Prova una pagina con un visualizzatore o l’estensione del browser.",
  "view.discovery.noneExtension":
    "Nessuna immagine zoomabile trovata su questa pagina. Segnala un problema con la diagnostica o segui la guida per trovare l’indirizzo dell’immagine.",
  "desktop.plan.none":
    "Questa immagine non ha dimensioni utili da salvare da {host}. Prova un’altra immagine o una Larghezza max minore.",
  "desktop.transport.stalled":
    "Salvataggio fermo durante il contatto con {host}. Controlla la connessione e riprova.",
  "desktop.output.writeFail":
    "Impossibile scrivere questa immagine da {host}. Scegli un’altra destinazione e riprova.",
  "desktop.job.cancelledMsg":
    "Il salvataggio dell’immagine è stato interrotto. Ogni file incompleto è stato rimosso.",
  "desktop.start.failed":
    "Impossibile avviare il salvataggio di questa immagine da {host}. Riprova.",
  "desktop.choice.failed": "Questa scelta non è stata accettata. Riprova.",
  "desktop.internal.error":
    "Un problema imprevisto ha interrotto questo salvataggio da {host}. Riprova e copia la diagnostica se ricapita.",
  "desktop.save.fallback": "Impossibile salvare questa immagine da {host}. Riprova.",
  "desktop.invoke.startFallback": "Impossibile avviare l’attività.",
  "desktop.invoke.retry": "La scelta di riprovare è stata rifiutata.",
  "desktop.cancel.note": "Salvataggio annullato. Pulizia fatta e ogni file incompleto rimosso.",
  "desktop.copy.diagnostics": "Copia la diagnostica",
  "desktop.copy.copied": "Copiata!",
  "desktop.panel.jobActions": "Azioni dell’attività desktop",
  "desktop.settings.reset": "Reimposta le impostazioni",
  "desktop.quick.info": "Altre informazioni",
  "desktop.quick.auto": "Automatico",
  "desktop.quick.compression": "Compressione",
  "desktop.quick.compressionInfo":
    "Valori più elevati mirano a file più piccoli. Ogni formato determina l’effetto sulla qualità e sui tempi di codifica.",
  "desktop.quick.compressionUnavailable": "La compressione non è regolabile per questo formato.",
  "desktop.quick.compressionWarning":
    "Forte perdita di dettagli: questa compressione può rendere il testo e i dettagli fini illeggibili.",
  "desktop.quick.sizeEstimate": "Fino a circa {size}",
  "desktop.quick.folderInfo": "Scegli dove salvare le immagini scaricate.",
  "desktop.quick.formatInfo":
    "Scegli un formato. Automatico seleziona un formato adatto all’immagine.",
  "desktop.quick.sizeInfo":
    "Ogni stima presuppone un’immagine che occupi la larghezza e l’altezza massime della preimpostazione. Una sorgente più piccola o proporzioni diverse possono produrre un file molto più piccolo. Le stime interpolano misure per formato e compressione, includono i livelli aggiuntivi della piramide, aggiungono un margine del 10 % e sono arrotondate per eccesso a due cifre significative con unità adatte alla dimensione. Sono indicazioni orientative, non limiti garantiti di file o memoria; dettagli, trasparenza e metadati influenzano il risultato. Automatico presume un JPEG opaco; la trasparenza usa PNG. Le preimpostazioni scelgono un livello sorgente senza ridimensionare. Se nessuno rientra, viene usato il più piccolo, che può superare il massimo scelto. Le dimensioni intere/personalizzate dipendono dalla sorgente.",
  "desktop.quick.maxWidth": "Larghezza max.",
  "desktop.quick.maxHeight": "Altezza max.",
  "desktop.quick.original": "Originale",
  "desktop.quick.userDefined": "Personalizzata",
  "desktop.quick.estimatedSize": "Stima alla dimensione max. ({format})",
  "desktop.quick.networkInfo":
    "Veloce usa fino a 16 richieste simultanee senza attesa. Bilanciato avvia fino a 5 richieste al secondo; Delicato fino a 2. Un ritmo ridotto può aiutare i server occupati.",
  "desktop.quick.source": "Dipende dalla fonte",
  "desktop.quick.exact": "Personalizzato",
  "desktop.quick.upTo": "Fino a {size}K",
  "desktop.quick.hint.adaptive": "adattivo",
  "desktop.quick.hint.lossless": "senza perdita",
  "desktop.quick.hint.compressed": "compresso",
  "desktop.quick.hint.advancedCompression": "compressione avanzata",
  "desktop.quick.hint.archival": "archivio",
  "desktop.quick.hint.zoomable": "ingrandibile",
  "desktop.quick.hint.tiled": "a tasselli",
  "desktop.quick.format.auto":
    "JPEG per immagini opache fino a {maxSide} pixel per lato; PNG per trasparenza o immagini più grandi. La compressione vale anche per Automatico.",
  "desktop.quick.format.png":
    "Pixel senza perdita e trasparenza; file più grandi, adatti alla modifica.",
  "desktop.quick.format.jpeg":
    "File più piccoli con perdita. Nessuna trasparenza; massimo {maxSide} pixel per lato. Regola la compressione nel menu Dimensione.",
  "desktop.quick.format.tiff": "Formato senza perdita per archiviazione e modifica.",
  "desktop.quick.format.webp": "Formato compresso senza perdita, massimo {maxSide} pixel per lato.",
  "desktop.quick.format.zif": "Piramide TIFF a tasselli senza perdita per diverse risoluzioni.",
  "desktop.quick.format.iiifDir":
    "Cartella con tasselli JPEG e info.json per ospitare un’immagine IIIF.",
  "desktop.quick.rate.maximum": "16 parallele",
  "desktop.quick.rate.balanced": "5/s",
  "desktop.quick.rate.gentle": "2/s",
  "desktop.quick.folder": "Cartella",
  "desktop.quick.askEachTime": "Chiedi ogni volta",
  "desktop.quick.chosenFolder": "Cartella scelta",
  "desktop.quick.chooseFolder": "Scegli la cartella iniziale per il salvataggio",
  "desktop.quick.format": "Formato",
  "desktop.quick.size": "Dimensione",
  "desktop.quick.network": "Rete",
  "desktop.quick.fast": "Veloce",
  "desktop.quick.balanced": "Bilanciata",
  "desktop.quick.gentle": "Delicata",
  "desktop.quick.fullResolution": "Risoluzione completa",
  "desktop.quick.upTo4k": "Fino a 4K",
  "desktop.quick.upTo2k": "Fino a 2K",
  "desktop.quick.custom": "Personalizzata…",
  "desktop.quick.more": "Altre impostazioni",
  "desktop.advanced.title": "Impostazioni avanzate",
  "desktop.advanced.done": "Fine",
  "desktop.output.codecLimit":
    "Questa immagine ({dims}) è troppo grande per {format}, che consente al massimo {maxSide} pixel per lato. Salvala in PNG. Origine: {host}.",
  "desktop.quick.format.avif":
    "Compressione avanzata con trasparenza. Formato con perdita, massimo {maxSide} pixel per lato. Regola la compressione nel menu Dimensione. Richiede l’immagine completa in memoria e non conserva i profili colore incorporati. Anche la compressione minima è con perdita.",
  "desktop.quick.format.generic": "Salva l’immagine in formato {format}.",
  "desktop.advanced.dimensions": "Dimensioni personalizzate",
  "desktop.advanced.dimensionsDesc":
    "Lascia vuoto un valore per mantenere le proporzioni originali.",
  "desktop.advanced.width": "Larghezza",
  "desktop.advanced.height": "Altezza",
  "desktop.advanced.retries": "Tentativi",
  "desktop.advanced.retriesDesc": "Tentativi automatici prima di chiedere se riprovare una volta.",
  "desktop.advanced.resumeCache": "Cache di ripresa",
  "desktop.advanced.resumeCacheDesc": "Riutilizza i frammenti dopo un salvataggio interrotto.",
  "desktop.advanced.choose": "Scegli…",
  "desktop.advanced.change": "Modifica…",
  "desktop.advanced.headers": "Intestazioni della richiesta",
  "desktop.advanced.headersDesc": "Per i visori protetti. Inviate solo all’origine dell’immagine.",
  // Extension job-tab user copy, rendered through the same `t(key, vars)`
  // shape; log and diagnostics lines stay literal English and never use these
  // keys. `test/ui-i18n.test.mjs` fails when the page renders a key outside
  // this table.
} as const;
