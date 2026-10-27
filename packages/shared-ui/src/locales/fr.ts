// French message dictionary for the shared UI.
//
// Translation of `../i18n.ts`, key for key: every English key has exactly one French
// entry with identical `{placeholders}`. Missing keys fall back to English at
// lookup time, so this table must never drop a key when English grows.
// Brand and product names ("Dezoomify", "Chrome Web Store", "GitHub Releases",
// "GPL", "PNG", "JPEG", "URL", "CLI", "FAQ") stay literal.
//
// Erasable-syntax-only TypeScript (plain object, no enums) so node can
// type-strip it directly in tests.

export const fr = {
  "view.images.title": "Choisir une image",
  "view.images.untitled": "Image {number}",
  "view.images.noPreview": "Aucun aperçu disponible",
  "view.images.unknownSize": "Dimensions inconnues",
  "view.images.choose": "Choisir",
  "view.images.chooseNamed": "Choisir {title} (image {number})",
  "view.images.cancel": "Annuler",
  "page.brand": "Enregistrer des images zoomables",
  "page.nav.label": "Navigation principale",
  "page.nav.extension": "Extension de navigateur",
  "page.nav.desktop": "Application de bureau",
  "page.nav.help": "Aide",
  "page.nav.donate": "Faire un don",
  "page.nav.donateTitle": "Contribuer aux frais d’hébergement",
  "page.footer.source": "Code source (GPL)",
  "page.footer.faq": "Questions fréquentes",
  "page.footer.privacy": "Confidentialité",
  "page.footer.terms": "Conditions d’utilisation",
  "page.legacy.title": "Vous cherchez l’ancien Dezoomify ?",
  "page.legacy.link": "Ouvrir l’ancienne version",
  "page.preview.zoomOut": "Dézoomer",
  "page.preview.zoomIn": "Zoomer",
  "page.preview.reset": "Rétablir le zoom à 100 pour cent",
  "page.preview.fit": "Ajuster",
  "page.preview.fitLabel": "Adapter l’image à l’aperçu",
  "view.diagnostics.signedInNote":
    "Si ce site nécessite une connexion, ces détails peuvent contenir des informations sensibles. Vérifiez-les avant de les partager.",
  "view.diagnostics.save": "Enregistrer le rapport de diagnostic",
  "view.diagnostics.copyFailed": "Copie impossible. Sélectionnez et copiez les détails ci-dessous.",
  "view.diagnostics.loadFailed":
    "Le rapport complet est inaccessible. Les détails disponibles sont affichés ci-dessous.",
  "view.retry.title": "Téléchargement en pause",
  "view.retry.summary": "{done} fragments sur {total} ont été récupérés.",
  "view.retry.explanation":
    "Les tentatives automatiques ont échoué. Réessayez ou annulez ; aucun fichier n’a été enregistré.",
  "view.retry.retry": "Réessayer une fois",
  "view.retry.cancel": "Annuler",
  "desktop.done.title": "Image enregistrée",
  "desktop.done.size": "{width} × {height} pixels",
  "desktop.done.saved": "Enregistrée dans le dossier choisi.",
  "desktop.done.open": "Ouvrir l’image",
  "desktop.done.reveal": "Afficher dans le dossier",
  "desktop.done.openError":
    "Impossible d’ouvrir l’image. Vérifiez qu’une visionneuse par défaut est installée.",
  "desktop.done.folderError":
    "Impossible d’ouvrir le dossier. Vérifiez qu’un gestionnaire de fichiers est installé.",
  "desktop.done.missingError": "L’image ou le dossier n’existe plus.",
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Compris",
  "view.modal.closeDialog": "Fermer la boîte de dialogue",
  "view.modal.closeTitle": "Fermer",
  // Desktop-app guidance modal.
  "view.desktop.title": "Application de bureau Dezoomify",
  "view.desktop.download.windows": "Programme d’installation Windows · x64 (MSI)",
  "view.desktop.download.macos": "Programme d’installation macOS · Apple Silicon (DMG)",
  "view.desktop.download.linux": "Programme d’installation Linux · x64 (DEB)",
  "view.desktop.step1":
    "Téléchargez le programme d’installation ci-dessus pour votre système, puis installez-le.",
  "view.desktop.subtitle": "Enregistrez de grandes images directement sur votre ordinateur",
  "view.desktop.whyTitle": "Pourquoi utiliser l’application de bureau ?",
  "view.desktop.why1Title": "Téléchargez de plus grandes images :",
  "view.desktop.why1Body":
    "Enregistrez des images qui dépassent les limites de taille de votre navigateur. L’application peut construire le fichier au fil du téléchargement, sans garder toute l’image en mémoire. Les très grandes images peuvent tout de même nécessiter un autre format ou une taille réduite.",
  "view.desktop.why2Title": "Utilisez votre propre connexion :",
  "view.desktop.why2Body":
    "L’application récupère les informations sur l’image et chacun de ses fragments directement sur le site d’origine, avec votre connexion internet. Cela peut aider lorsqu’un site bloque le serveur partagé de Dezoomify.",
  "view.desktop.why3Title": "Choisissez votre format de fichier :",
  "view.desktop.why3Body":
    "Enregistrez en JPEG, PNG, TIFF ou dans d’autres formats pour consulter, retoucher ou archiver vos images. Choisissez le dossier où elles seront enregistrées.",
  "view.desktop.howTitle": "Comment l’utiliser",
  "view.desktop.step2": "Ouvrez Dezoomify et collez l’adresse de la page ou de l’image zoomable.",
  "view.desktop.step3":
    "Choisissez un dossier, un format de fichier et une taille d’image, puis lancez le téléchargement.",
  "view.desktop.cliTitle": "Besoin d’automatiser ? Essayez Dezoomify CLI",
  "view.desktop.cliDesc":
    "Utilisez la version en ligne de commande pour télécharger des images avec des scripts ou traiter une liste d’adresses.",
  "view.desktop.cliLink": "Télécharger le CLI depuis GitHub Releases",
  // Browser-extension guidance modal.
  "view.ext.title": "Extension de navigateur Dezoomify",
  "view.ext.subtitle":
    "Enregistrez les images zoomables de la page que vous consultez, y compris sur les sites où vous êtes connecté",
  "view.ext.availableOn": "Disponible sur",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxStore": "Firefox Browser Add-ons",
  "view.ext.whyTitle": "Pourquoi utiliser l’extension de navigateur ?",
  "view.ext.why1Title": "Utilisez votre connexion au site :",
  "view.ext.why1Body":
    "Téléchargez les images auxquelles vous avez accès en étant connecté à une bibliothèque, un musée ou des archives. Si l’accès à un autre site est nécessaire, l’extension vous demande l’autorisation.",
  "view.ext.why2Title": "Retrouvez l’image sans chercher son adresse :",
  "view.ext.why2Body":
    "Cliquez sur Dezoomify dans la barre d’outils du navigateur pour trouver l’image dans la visionneuse de la page. Le téléchargement démarre dans un nouvel onglet. Les limites de taille du navigateur s’appliquent toujours.",
  "view.ext.why3Title": "Agit à votre demande :",
  "view.ext.why3Body":
    "L’extension examine la page uniquement lorsque vous cliquez sur son bouton. Elle ne surveille pas votre navigation en arrière-plan.",
  "view.ext.howTitle": "Comment l’utiliser en 3 étapes",
  "view.ext.step1": "Installez l’extension depuis le Chrome Web Store ou Firefox Browser Add-ons.",
  "view.ext.step2":
    "Ouvrez la page de votre image, connectez-vous si nécessaire et zoomez une fois pour laisser l’image se charger.",
  "view.ext.step3":
    "Cliquez sur Dezoomify dans la barre d’outils du navigateur. Autorisez l’accès si demandé et gardez l’onglet de téléchargement ouvert jusqu’à la fin de l’enregistrement.",
  // Access request (browser-session file access), shared access-request.tsx.
  "view.access.title": "Autoriser l’accès pour continuer",
  "view.access.usesOrigin": "Cette image utilise des fichiers de {origin}.",
  "view.access.needAccess":
    "Dezoomify a besoin d’accès pour lire ces fichiers et assembler votre image dans ce navigateur.",
  "view.access.requesting": "Demande d’accès en cours…",
  "view.access.allow": "Autoriser l’accès et continuer",
  // Idle input section.
  "view.idle.clearTitle": "Effacer la saisie",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Recherche de l’image zoomable…",
  "view.step.preflighting": "Vérification de la taille de l’image…",
  "view.step.downloading": "Téléchargement des fragments…",
  "view.step.saving": "Assemblage de l’image finale…",
  "view.step.contactingDetail": "Connexion au site d’origine…",
  // Live job section.
  "view.job.techDetails": "Détails techniques et journaux",
  "view.job.manyImages": "{count} images",
  "view.job.paused": "En pause",
  "view.job.retryingTiles": "Nouvelle tentative pour {count} fragments…",
  "view.job.waiting": "En attente de {host}…",
  "view.job.sourceLabel": "Source",
  "view.job.pause": "Pause",
  "view.job.resume": "Reprendre",
  "view.job.stopReturn": "Arrêter et revenir au début",
  "view.job.progressValue": "{done} terminées, {active} en cours, {remaining} restantes",
  // Display-only section.
  "view.display.title": "Aperçu affiché, non enregistré",
  "view.display.waysTitle": "Moyens d’enregistrer cette œuvre",
  "view.display.extTitle": "Guide de l’extension de navigateur",
  "view.display.extDesc":
    "Retrouvez l’image sur la page que vous consultez, y compris lorsque vous êtes connecté.",
  "view.display.deskTitle": "Guide de l’application de bureau",
  "view.display.deskDescClean":
    "Téléchargez directement depuis le site d’origine lorsque votre navigateur ne peut afficher qu’un aperçu.",
  "view.display.startOver": "Recommencer",
  "view.resolution.title": "Image de résolution réduite",
  "view.resolution.sizes":
    "Taille de l’image : {selected} pixels. Maximum disponible : {maximum} pixels.",
  "view.resolution.download": "Obtenir la résolution maximale avec l’application de bureau",
  "view.desktop.handoffTitle": "Télécharger cette image dans l’application de bureau",
  "view.desktop.handoffInstall":
    "Choisissez l’installeur pour votre système, puis ouvrez Dezoomify.",
  "view.desktop.handoffPaste": "Collez cette adresse dans l’application de bureau :",
  "view.desktop.handoffCopy": "Copier l’adresse",
  "view.desktop.handoffCopied": "Adresse copiée. Collez-la dans l’application de bureau.",
  "view.desktop.handoffCopyFailed":
    "Copie impossible. Sélectionnez l’adresse ci-dessus et copiez-la manuellement.",
  "view.desktop.handoffStart":
    "Choisissez Résolution complète dans le menu Taille, puis lancez le téléchargement.",
  "view.desktop.handoffAccess":
    "L’application de bureau ne peut pas utiliser votre connexion au site dans le navigateur. Pour les images qui nécessitent de se connecter, essayez l’extension de navigateur.",
  "view.desktop.handoffUnavailable":
    "Aucune adresse d’image n’est disponible pour ce téléchargement. Copiez l’adresse de la page d’origine et essayez-la dans l’application de bureau.",
  // Completion section.
  "view.done.ready": "Votre image est prête.",
  "view.done.readyTitle": "Prêt à enregistrer",
  "view.done.saveNow": "Enregistrer l’image maintenant",
  "view.done.another": "Dezoomifier une autre image",
  "view.done.guidance":
    "Utilisez le bouton d’enregistrement pour télécharger votre image. Les couleurs peuvent varier légèrement, car les téléchargements dans le navigateur ne conservent pas le profil colorimétrique d’origine. Pour les formats qui préservent ces profils, utilisez l’application de bureau.",
  "view.done.summary": "{width} × {height} pixels ({mime})",
  "view.done.fallback":
    "Une image disponible sur cette page a été enregistrée. Si ce n’est pas celle que vous souhaitiez, vous pouvez le signaler dans les détails techniques ci-dessous.",
  "view.display.guidance":
    "Votre navigateur peut afficher cette image, mais le site d’origine ne l’autorise pas à créer un fichier téléchargeable. Essayez l’application de bureau ou l’extension de navigateur pour l’enregistrer.",
  // Failure section.
  "view.fail.title": "Impossible de dézoomifier l’image",
  "view.fail.deskDescLimits":
    "Enregistrez de plus grandes images directement depuis le site d’origine avec votre propre connexion internet.",
  "view.fail.helpTitle": "Aide pour trouver une image",
  "view.fail.helpDesc":
    "Comment trouver l’adresse de l’image sur les sites de musées et d’archives, et quoi essayer quand rien n’est trouvé.",
  "view.fail.reportBug": "Signaler un bogue sur GitHub",
  "view.fail.reportBugDesc": "Préparez un ticket GitHub avec les diagnostics de cette tentative.",
  "view.fail.retry": "Réessayer",
  "view.fail.canvasAllocation":
    "Cette image est trop grande pour cet onglet. Essayez l’application de bureau pour enregistrer une image plus grande.",
  "view.fail.canvasContext":
    "Votre navigateur n’a pas pu préparer une image de cette taille. Essayez l’application de bureau ou fermez d’autres onglets avant de réessayer.",
  // Cancelled section.
  "view.cancel.title": "Enregistrement annulé",
  "view.cancel.message": "L’enregistrement de l’image a été interrompu.",
  // Job section and share chrome.
  "view.job.countsFull": "{current} fragments sur {total}",
  "view.job.pixelCounts": "{current} sur {total}",
  "view.job.pixels": "{count} px",
  "view.job.megapixels": "{count} Mpx",
  "view.job.gigapixels": "{count} Gpx",
  "view.job.preparation":
    "{percent} % des pixels préparés. Finalisation de l’enregistrement de l’image.",
  "view.job.countsActive": "{current} fragments sur {total} · {active} en cours",
  // Recent pictures, including unsuccessful attempts.
  "view.history.title": "Images récentes",
  "view.history.empty": "Aucune image récente pour le moment. Les images lancées apparaissent ici.",
  "view.history.localOnly": "Conservé uniquement sur cet appareil.",
  "view.history.clear": "Effacer l’historique",
  "view.history.source": "Source",
  "view.history.time": "Début",
  "view.history.size": "Taille (px)",
  "view.history.result": "Résultat",
  "view.history.remove": "Supprimer",
  "view.history.removeImage": "Supprimer {image} des images récentes",
  "view.history.status.started": "Démarré",
  "view.history.status.completed": "Terminé",
  "view.history.status.preview": "Aperçu seul",
  "view.history.status.failed": "Échec",
  "view.history.status.cancelled": "Annulé",
  "view.history.status.deleted": "Supprimé",
  "view.history.status.checking": "Vérification…",
  "view.history.status.unavailable": "Fichier inaccessible",
  "view.history.status.opening": "Ouverture…",
  "view.history.openImage": "Ouvrir {image}",
  "view.history.openFailed": "Impossible d’ouvrir le fichier.",
  "view.input.description":
    "Enregistrez des images zoomables de musées, de bibliothèques, d’archives et d’autres sites web. Collez l’adresse de la page qui affiche votre image pour commencer.",
  "view.input.placeholder": "Collez l’adresse d’une page ou d’une image",
  "view.input.aria": "Adresse de la page contenant votre image zoomable",
  "view.input.start": "Trouver l’image",
  // Rate-limit explainers (see failure.ts plainMessageFor).
  "view.fail.rateProxy":
    "Le site d’origine limite les téléchargements depuis notre serveur. Patientez quelques minutes, ou essayez l’application de bureau ou l’extension de navigateur pour télécharger avec votre propre connexion internet.",
  "view.fail.rateDirect":
    "Le site d’origine limite les téléchargements depuis votre propre connexion. Patientez quelques minutes avant de réessayer. L’application de bureau et l’extension utilisent la même connexion et ne résoudront pas forcément le problème.",
  // Fetch-failure family (see failure.ts plainMessageFor).
  "view.fail.httpNotFound": "Cette page est introuvable. Vérifiez l’adresse et réessayez.",
  "view.fail.httpRefused":
    "Le site a refusé de partager ce fichier (HTTP {http}). Ouvrez la page d’origine pour vérifier que vous avez toujours accès à l’image, puis réessayez.",
  "view.fail.httpRefusedProxy":
    "Le site a refusé d’envoyer ce fichier au serveur de Dezoomify (HTTP {http}). Essayez l’extension de navigateur ou l’application de bureau pour télécharger directement avec votre propre connexion internet.",
  "view.fail.httpSiteProblem":
    "Le site a rencontré un problème pour ouvrir cette page. Réessayez bientôt.",
  "view.fail.httpNotOpened": "Cette page n’a pas pu être ouverte. Vérifiez l’adresse et réessayez.",
  "view.fail.policyBlocked":
    "Cette adresse ne peut pas être ouverte via le site. {hint} L’extension de navigateur ou l’application de bureau peuvent peut-être encore fonctionner.",
  "view.fail.hintAddress": "Vérifiez l’adresse et réessayez.",
  "view.fail.hintPrivate": "Le site ne peut pas ouvrir les adresses privées ou locales.",
  "view.fail.hintContentType":
    "Le site d’origine a renvoyé un type de fichier que Dezoomify ne peut pas lire ici.",
  "view.fail.hintRedirect": "Le site a redirigé d’une manière que le site ne peut pas suivre.",
  "view.fail.proxyBudget":
    "Ce fichier est trop volumineux pour notre serveur. Essayez l’application de bureau pour le télécharger directement.",
  "view.fail.proxyFetch":
    "Notre serveur n’a pas pu récupérer cette adresse. Réessayez dans un instant, ou utilisez l’application de bureau pour vous connecter directement au site d’origine.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid":
    "Veuillez saisir une adresse web valide commençant par http:// ou https://",
  "desktop.settings.unusable":
    "Ces paramètres de téléchargement ne peuvent pas être utilisés. Ajustez les paramètres surlignés et réessayez.",
  "desktop.settings.invalidSubmit":
    "Ces paramètres de téléchargement sont invalides. Ajustez-les et réessayez.",
  "desktop.output.deniedPick":
    "La destination d’enregistrement n’a pas été acceptée. Choisissez un autre fichier pour continuer.",
  "desktop.output.exists":
    "Un fichier existe déjà à la destination d’enregistrement depuis {host}. Choisissez un autre fichier ou confirmez l’écrasement pour continuer.",
  "desktop.output.destDenied":
    "La destination d’enregistrement n’a pas été acceptée depuis {host}. Choisissez un autre fichier pour continuer.",
  "desktop.job.gone":
    "Cette tâche n’est plus active depuis {host}. Recommencez avec une adresse récente.",
  "desktop.msg.thisPicture": "cette image",
  "desktop.msg.dimsPixels": "{a} par {b} pixels",
  "desktop.msg.needAbout": " Elle a besoin d’environ {need} de mémoire",
  "desktop.output.canvasLimit":
    "Cette image nécessite plus de mémoire que la quantité disponible ({dims},{need} ; limite {limit}). Enregistrez une version plus petite avec Largeur max (CLI : --max-width), ou choisissez un dossier de tuiles. Depuis {host}.",
  "desktop.tile.failed":
    "Impossible de récupérer un fragment depuis {host}. Vérifiez l’image source et réessayez.",
  "view.discovery.none":
    "Aucune image zoomable trouvée à cette adresse. Essayez une page avec un visualiseur, ou essayez l’extension.",
  "view.discovery.noneExtension":
    "Aucune image zoomable trouvée sur cette page. Signalez un bogue avec les diagnostics, ou suivez le guide pour trouver l’adresse de l’image.",
  "desktop.plan.none":
    "Cette image n’a aucune taille utilisable à enregistrer depuis {host}. Essayez une autre image ou une Largeur max plus petite.",
  "desktop.transport.stalled":
    "Enregistrement bloqué lors du contact avec {host}. Vérifiez votre connexion et réessayez.",
  "desktop.output.writeFail":
    "Impossible d’écrire cette image depuis {host}. Choisissez une autre destination et réessayez.",
  "desktop.job.cancelledMsg":
    "L’enregistrement de l’image a été interrompu. Tout fichier inachevé a été supprimé.",
  "desktop.start.failed":
    "Impossible de démarrer l’enregistrement de cette image depuis {host}. Réessayez.",
  "desktop.choice.failed": "Ce choix n’a pas été accepté. Réessayez.",
  "desktop.internal.error":
    "Une erreur interne de Dezoomify a interrompu cet enregistrement depuis {host}. Signalez ce bug avec les diagnostics.",
  "desktop.save.fallback": "Impossible d’enregistrer cette image depuis {host}. Réessayez.",
  "desktop.invoke.startFallback": "Impossible de démarrer la tâche.",
  "desktop.invoke.retry": "Le choix de nouvelle tentative a été refusé.",
  "desktop.cancel.note":
    "Enregistrement annulé. Le nettoyage est terminé et tout fichier inachevé a été supprimé.",
  "desktop.copy.diagnostics": "Copier les diagnostics",
  "desktop.copy.copied": "Copie !",
  "desktop.panel.jobActions": "Actions de la tâche de bureau",
  "desktop.settings.reset": "Réinitialiser les paramètres",
  "desktop.quick.info": "Plus d’informations",
  "desktop.quick.auto": "Automatique",
  "desktop.quick.compression": "Compression",
  "desktop.quick.compressionInfo":
    "Les valeurs élevées visent des fichiers plus petits. Chaque format détermine l’effet sur la qualité et le temps d’encodage.",
  "desktop.quick.compressionUnavailable": "La compression n’est pas réglable pour ce format.",
  "desktop.quick.compressionWarning":
    "Forte perte de détails : cette compression peut rendre le texte et les détails fins illisibles.",
  "desktop.quick.sizeEstimate": "Jusqu’à environ {size}",
  "desktop.quick.folderInfo": "Choisissez où enregistrer les images téléchargées.",
  "desktop.quick.formatInfo":
    "Choisissez un format. Le mode automatique sélectionne un format adapté à l’image.",
  "desktop.quick.sizeInfo":
    "Chaque estimation suppose une image occupant la largeur et la hauteur maximales du préréglage. Une source plus petite ou un autre rapport largeur/hauteur peut produire un fichier bien plus petit. Les estimations interpolent des mesures par format et compression, incluent les niveaux de pyramide nécessaires, ajoutent une marge de 10 % et sont arrondies vers le haut à deux chiffres significatifs avec une unité adaptée à la taille. Ce sont des budgets indicatifs, pas des limites garanties de fichier ou de mémoire ; détails, transparence et métadonnées influencent le résultat. Le mode automatique suppose un JPEG opaque ; la transparence utilise le PNG. Les préréglages choisissent un niveau source sans redimensionner. Si aucun ne convient, le plus petit est utilisé et peut dépasser le maximum choisi. Les tailles entière/personnalisée dépendent de la source.",
  "desktop.quick.maxWidth": "Largeur max.",
  "desktop.quick.maxHeight": "Hauteur max.",
  "desktop.quick.original": "Originale",
  "desktop.quick.userDefined": "Personnalisée",
  "desktop.quick.estimatedSize": "Estimation à la taille max. ({format})",
  "desktop.quick.networkInfo":
    "Choisissez le rythme de lancement des requêtes de tuiles vers chaque serveur, pas une vitesse de téléchargement fixe. Automatique est recommandé. Doux limite le rythme dès le départ ; Agressif essaie des rythmes plus élevés.",
  "desktop.quick.networkMode": "Mode",
  "desktop.quick.networkStart": "Au départ",
  "desktop.quick.networkMax": "Peut atteindre",
  "desktop.quick.requestsPerSecond": "{rate} requêtes/s",
  "desktop.quick.networkAdaptive":
    "Tous les modes interrompent et ralentissent automatiquement les requêtes vers un serveur qui signale une limite, en respectant le délai demandé. Après des requêtes réussies, le rythme augmente progressivement sans dépasser le maximum choisi. Chaque mode autorise jusqu’à 16 téléchargements de tuiles simultanés ; la vitesse réelle dépend aussi du serveur et de votre connexion.",
  "desktop.quick.source": "Selon la source",
  "desktop.quick.exact": "Personnalisé",
  "desktop.quick.upTo": "Jusqu’à {size}K",
  "desktop.quick.hint.adaptive": "adaptatif",
  "desktop.quick.hint.lossless": "sans perte",
  "desktop.quick.hint.compressed": "compressé",
  "desktop.quick.hint.advancedCompression": "compression avancée",
  "desktop.quick.hint.archival": "archivage",
  "desktop.quick.hint.zoomable": "zoomable",
  "desktop.quick.hint.tiled": "tuilé",
  "desktop.quick.format.auto":
    "JPEG pour les images opaques jusqu’à {maxSide} pixels par côté ; PNG pour la transparence ou les images plus grandes. La compression s’applique aussi au mode automatique.",
  "desktop.quick.format.png":
    "Pixels sans perte et transparence ; fichiers plus volumineux, adaptés à la retouche.",
  "desktop.quick.format.jpeg":
    "Fichiers plus petits avec perte. Sans transparence ; limite de {maxSide} pixels par côté. Réglez la compression dans le menu Taille.",
  "desktop.quick.format.tiff": "Sortie sans perte pour l’archivage et la retouche.",
  "desktop.quick.format.webp": "Sortie compressée sans perte, limitée à {maxSide} pixels par côté.",
  "desktop.quick.format.zif":
    "Pyramide TIFF tuilée sans perte pour zoomer à plusieurs résolutions.",
  "desktop.quick.format.iiifDir":
    "Dossier de tuiles JPEG et info.json pour héberger une image IIIF.",
  "desktop.quick.rate": "Jusqu’à {max}/s",
  "desktop.quick.folder": "Dossier",
  "desktop.quick.askEachTime": "Demander à chaque fois",
  "desktop.quick.chosenFolder": "Dossier choisi",
  "desktop.quick.chooseFolder": "Choisir le dossier de départ de la boîte d’enregistrement",
  "desktop.quick.format": "Format",
  "desktop.quick.size": "Taille",
  "desktop.quick.network": "Réseau",
  "desktop.quick.automatic": "Automatique",
  "desktop.quick.aggressive": "Agressif",
  "desktop.quick.gentle": "Doux",
  "desktop.quick.fullResolution": "Résolution complète",
  "desktop.quick.upTo4k": "Jusqu’à 4K",
  "desktop.quick.upTo2k": "Jusqu’à 2K",
  "desktop.quick.custom": "Personnalisé…",
  "desktop.quick.more": "Plus de réglages",
  "desktop.advanced.title": "Réglages avancés",
  "desktop.advanced.done": "Terminé",
  "desktop.output.codecLimit":
    "Cette image ({dims}) est trop grande pour {format}, qui accepte au maximum {maxSide} pixels par côté. Enregistrez-la en PNG. Source : {host}.",
  "desktop.quick.format.avif":
    "Compression avancée avec transparence. Sortie avec perte, limitée à {maxSide} pixels par côté. Réglez la compression dans le menu Taille. Nécessite l’image complète en mémoire et ne conserve pas les profils colorimétriques intégrés. Même la compression minimale est avec perte.",
  "desktop.quick.format.generic": "Enregistrer l’image au format {format}.",
  "desktop.advanced.dimensions": "Dimensions personnalisées",
  "desktop.advanced.dimensionsDesc":
    "Laissez une valeur vide pour conserver les proportions originales.",
  "desktop.advanced.width": "Largeur",
  "desktop.advanced.height": "Hauteur",
  "desktop.advanced.retries": "Essais",
  "desktop.advanced.retriesDesc":
    "Tentatives automatiques avant de proposer de réessayer une fois.",
  "desktop.advanced.resumeCache": "Cache de reprise",
  "desktop.advanced.resumeCacheDesc":
    "Réutiliser les fragments après un enregistrement interrompu.",
  "desktop.advanced.choose": "Choisir…",
  "desktop.advanced.change": "Modifier…",
  "desktop.advanced.headers": "En-têtes de requête",
  "desktop.advanced.headersDesc":
    "Pour les visionneuses protégées. Envoyées seulement à l’origine de l’image.",
  // Extension job-tab user copy, rendered through the same `t(key, vars)`
  // shape; log and diagnostics lines stay literal English and never use these
  // keys. `test/ui-i18n.test.mjs` fails when the page renders a key outside
  // this table.
} as const;
