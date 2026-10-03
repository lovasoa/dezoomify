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
  "view.diagnostics.signedInNote":
    "Si ce site nécessite une connexion, ces détails peuvent contenir des informations sensibles. Vérifiez-les avant de les partager.",
  "view.diagnostics.save": "Enregistrer le rapport de diagnostic",
  "view.diagnostics.copyFailed": "Copie impossible. Sélectionnez et copiez les détails ci-dessous.",
  "view.diagnostics.loadFailed":
    "Le rapport complet est inaccessible. Les détails disponibles sont affichés ci-dessous.",
  "desktop.done.title": "Image enregistrée",
  "desktop.done.partial": "Image enregistrée avec des parties manquantes",
  "desktop.done.size": "{width} × {height} pixels",
  "desktop.done.saved": "Enregistrée dans le dossier choisi.",
  "desktop.done.open": "Ouvrir l’image",
  "desktop.done.reveal": "Afficher dans le dossier",
  "desktop.done.openError":
    "Impossible d’ouvrir l’image. Vérifiez qu’une visionneuse par défaut est installée.",
  "desktop.done.folderError":
    "Impossible d’ouvrir le dossier. Vérifiez qu’un gestionnaire de fichiers est installé.",
  "desktop.done.missingError": "L’image ou le dossier n’existe plus.",
  "view.partial.title": "L’image est incomplète",
  "view.partial.summary": "{done} tuiles sur {total} ont été récupérées.",
  "view.partial.gaps":
    "L’image enregistrée aura des zones manquantes. Aucun fichier n’a encore été enregistré.",
  "view.partial.refused":
    "Le site a refusé les tuiles restantes. L’image enregistrée aura des zones manquantes.",
  "view.partial.save": "Enregistrer l’image incomplète",
  "view.partial.cancel": "Annuler",
  "view.partial.retry": "Réessayer les tuiles en échec",
  "view.partial.accessDenied": "Le site a refusé l’accès à cette image",
  "view.partial.empty": "L’image n’a pas pu être récupérée",
  "view.partial.noneSaved":
    "Aucune partie de l’image n’a pu être récupérée. Aucun fichier n’a été enregistré.",
  "view.partial.checkSource": "Ouvrez la page source et vérifiez que sa visionneuse fonctionne.",
  "view.partial.openSource": "Ouvrir la page source",
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Compris",
  "view.modal.closeDialog": "Fermer la boite de dialogue",
  "view.modal.closeTitle": "Fermer",
  // Desktop-app guidance modal.
  "view.desktop.title": "Application de bureau Dezoomify",
  "view.desktop.subtitle":
    "Application native haute performance pour les oeuvres museales gigapixels et les numerisations locales",
  "view.desktop.installer": "L’{installer} non signé pour {platform} est disponible sur",
  "view.desktop.releasesLink": "GitHub Releases",
  "view.desktop.releasesNote":
    "Pas de mise à jour automatique ; consultez GitHub Releases manuellement.",
  "view.desktop.installerMsi": "installeur .msi",
  "view.desktop.installerDmg": "installeur .dmg Apple silicon",
  "view.desktop.installerDeb": "installeur .deb",
  "view.desktop.installerGeneric": "installeur",
  "view.desktop.platformGeneric": "votre plateforme",
  "view.desktop.whyTitle": "Pourquoi utiliser l application de bureau ?",
  "view.desktop.why1Title": "Prend en charge les oeuvres tres grandes :",
  "view.desktop.why1Body":
    "Un onglet de navigateur ne peut contenir qu une certaine quantite d image. L application de bureau assemble l image en memoire (jusqu a sa limite de canevas de 8 Gio, avec la memoire libre correspondante) et ecrit le resultat sur le disque.",
  "view.desktop.why2Title": "Enregistre l image terminee :",
  "view.desktop.why2Body":
    "Chaque tache est enregistree dans un fichier de sortie sur votre ordinateur.",
  "view.desktop.why3Title": "Quand le site web ne peut pas terminer :",
  "view.desktop.why3Body":
    "Le site web interrompt la tache avec une erreur et renvoie vers l application de bureau pour l image en pleine taille.",
  "view.desktop.howTitle": "Comment l utiliser",
  "view.desktop.step1":
    "Téléchargez l’{installer} non signé pour {platform} depuis notre page GitHub Releases, puis installez-le. Il n’y a pas de mise à jour automatique.",
  "view.desktop.step2":
    "Lancez Dezoomify et collez l adresse de votre image zoomable ou de votre manifeste.",
  "view.desktop.step3":
    "Choisissez la resolution souhaitee et le dossier de destination pour enregistrer l image complete assemblee.",
  "view.desktop.cliTitle": "Besoin d automatiser ? Essayez Dezoomify CLI",
  "view.desktop.cliDesc":
    "Le CLI offre un enregistrement scriptable sans interface, ideal pour les chaines automatisees et les serveurs sans ecran.",
  "view.desktop.cliLink": "Obtenir le CLI sur GitHub Releases",
  // Browser-extension guidance modal.
  "view.ext.title": "Extension de navigateur Dezoomify",
  "view.ext.subtitle":
    "Detection automatique des visionneuses pour les archives numeriques protegees et les pages complexes",
  "view.ext.availableOn": "Disponible sur",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxStore": "Firefox Browser Add-ons",
  "view.ext.whyTitle": "Pourquoi utiliser l extension de navigateur ?",
  "view.ext.why1Title": "Pages avec connexion :",
  "view.ext.why1Body":
    "Pendant que vous regardez une image zoomable, elle retrouve automatiquement l image derriere la visionneuse, y compris sur les pages ou vous etes connecte, comme les portails de bibliotheques, les abonnements museaux et les archives universitaires.",
  "view.ext.why2Title": "Simple d utilisation :",
  "view.ext.why2Body":
    "Appuyez sur le bouton Dezoomify dans la barre d outils du navigateur et choisissez l image a enregistrer, ou envoyez la tache vers l application de bureau si l image est tres grande.",
  "view.ext.why3Title": "Respectueux de la vie privee :",
  "view.ext.why3Body":
    "Elle examine uniquement la page que vous lui avez indiquee, et seulement apres que vous avez appuye sur le bouton. Elle n observe pas votre navigation en arriere-plan.",
  "view.ext.howTitle": "Comment l utiliser en 3 etapes",
  "view.ext.step1": "Installez l extension depuis le Chrome Web Store ou Firefox Browser Add-ons.",
  "view.ext.step2":
    "Rendez-vous sur la page du musee ou de la bibliotheque qui montre votre oeuvre, en vous connectant si besoin.",
  "view.ext.step3":
    "Cliquez sur l icone Dezoomify dans la barre d outils de votre navigateur pour detecter et extraire automatiquement l image en pleine resolution !",
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
  "view.step.discovering": "Recherche de l image zoomable…",
  "view.step.preflighting": "Verification de la taille de l image…",
  "view.step.downloading": "Enregistrement des tuiles…",
  "view.step.saving": "Assemblage de l image finale…",
  "view.step.contactingDetail": "Contact de l'hote de l'image…",
  // Live job section.
  "view.job.techDetails": "Details techniques et journaux",
  "view.job.manyImages": "{count} images",
  "view.job.paused": "En pause",
  "view.job.retryingTiles": "Nouvelle tentative sur les tuiles ({count})…",
  "view.job.waiting": "En attente de {host}…",
  "view.job.sourceLabel": "Source",
  "view.job.pause": "Pause",
  "view.job.resume": "Reprendre",
  "view.job.stopReturn": "Arrêter et revenir au début",
  "view.job.progressValue": "{done} terminées, {active} en cours, {remaining} restantes",
  // Display-only section.
  "view.display.title": "Apercu affiche, non enregistre",
  "view.display.waysTitle": "Moyens d enregistrer cette oeuvre",
  "view.display.extTitle": "Guide de l extension de navigateur",
  "view.display.extDesc":
    "Pour les pages demandant une connexion ou des cookies de session. Detecte automatiquement les visionneuses sur les pages actives.",
  "view.display.deskTitle": "Guide de l application de bureau",
  "view.display.deskDescClean":
    "Pour un enregistrement propre en pleine taille quand le navigateur peut seulement montrer l image.",
  "view.display.startOver": "Recommencer",
  "view.resolution.notice":
    "Le téléchargement ne se fait pas à la résolution maximale à cause des limites du navigateur. Essayez l application de bureau pour supprimer les limites du navigateur.",
  "view.resolution.sizes":
    "Enregistrement en {selected} pixels au lieu du maximum {maximum} pixels.",
  "view.resolution.download": "Télécharger l application de bureau",
  "view.resolution.tryMaximum": "Essayer le maximum",
  "view.resolution.stop": "Arrêter",
  // Completion section.
  "view.done.ready": "Votre image est prete.",
  "view.done.readyTitle": "Pret a enregistrer",
  "view.done.saveNow": "Enregistrer l image maintenant",
  "view.done.another": "Dezoomifier une autre image",
  // Failure section.
  "view.fail.title": "Impossible de dezoomifier l image",
  "view.fail.deskDescLimits":
    "Pour les images qui depassent les limites memoire du navigateur, dans la limite de canevas de 8 Gio (avec la memoire libre correspondante). Traitees en natif sur votre ordinateur.",
  "view.fail.helpTitle": "Aide et extraction d URL",
  "view.fail.helpDesc":
    "Comment trouver l adresse de l image sur les sites de musees et d archives, et quoi essayer quand rien n est trouve.",
  "view.fail.reportBug": "Signaler un bogue sur GitHub",
  "view.fail.retry": "Reessayer",
  "view.fail.canvasAllocation":
    "Cette image est trop grande pour être assemblée dans cet onglet. L application de bureau peut l enregistrer en taille réelle.",
  "view.fail.canvasContext":
    "Cet onglet n a pas pu créer la surface de l image à cette taille. L application de bureau peut l enregistrer en taille réelle.",
  // Cancelled section.
  "view.cancel.title": "Enregistrement annule",
  "view.cancel.message": "L enregistrement de l image a ete interrompu.",
  // Job section and share chrome.
  "view.job.countsFull": "{current} tuiles sur {total}",
  "view.job.countsActive": "{current} tuiles sur {total} · {active} en cours",
  // Recent-jobs history (todo 5.2): local-only ledger.
  "view.history.title": "Images recentes",
  "view.history.empty":
    "Aucune image recente pour le moment. Les images enregistrees apparaissent ici.",
  "view.history.localOnly": "Conserve uniquement sur cet appareil.",
  "view.history.clear": "Effacer l historique",
  "view.history.dims": "{w} par {h} pixels",
  "view.input.description":
    "Dezoomify télécharge des images zoomables en tuiles depuis des bibliothèques, des musées, des galeries et d’autres sites web. Collez ci-dessous l’adresse d’une image pour la télécharger.",
  "view.input.placeholder": "Collez l adresse d une visionneuse ou d un manifeste",
  "view.input.aria": "Adresse de la page contenant votre image zoomable",
  "view.input.start": "Trouver l image",
  // Rate-limit explainers (see failure.ts plainMessageFor).
  "view.fail.rateProxy":
    "Le site qui heberge cette image limite le nombre de pages que notre serveur peut lui demander, et cette limite vient d etre atteinte, donc la page n a pas pu etre ouverte. L extension de navigateur et l application de bureau telechargent depuis votre propre connexion au lieu de notre serveur, elles ne sont donc pas concernees par cette limite.",
  "view.fail.rateDirect":
    "Le site qui heberge cette image recoit actuellement trop de demandes depuis votre propre connexion. Attendre quelques minutes suffit generalement, et l extension de navigateur ou l application de bureau verront le meme signal d encombrement jusque-la.",
  // Fetch-failure family (see failure.ts plainMessageFor).
  "view.fail.httpNotFound": "Cette page est introuvable. Verifiez l adresse et reessayez.",
  "view.fail.httpRefused":
    "Le site a refuse de partager ce fichier (HTTP {http}). Il bloque peut-etre les serveurs partages ; l extension de navigateur ou l application de bureau peuvent peut-etre encore fonctionner.",
  "view.fail.httpSiteProblem":
    "Le site a rencontre un probleme pour ouvrir cette page. Reessayez bientot.",
  "view.fail.httpNotOpened": "Cette page n a pas pu etre ouverte. Verifiez l adresse et reessayez.",
  "view.fail.policyBlocked":
    "Cette adresse ne peut pas etre ouverte via le site. {hint} L extension de navigateur ou l application de bureau peuvent peut-etre encore fonctionner.",
  "view.fail.hintAddress": "Verifiez l adresse et reessayez.",
  "view.fail.hintPrivate": "Le site ne peut pas ouvrir les adresses privees ou locales.",
  "view.fail.hintContentType":
    "Le site a repondu avec un type de fichier que le site ne verifie pas ici.",
  "view.fail.hintRedirect": "Le site a redirige d une maniere que le site ne peut pas suivre.",
  "view.fail.proxyBudget":
    "Cette page est trop volumineuse a verifier ici. Essayez l application de bureau pour les tres grandes images.",
  "view.fail.proxyFetch":
    "Le proxy de metadonnees n a pas pu recuperer cette adresse. Reessayez bientot.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid":
    "Veuillez saisir une adresse web valide commencant par http:// ou https://",
  "desktop.settings.unusable":
    "Ces parametres de telechargement ne peuvent pas etre utilises. Ajustez les parametres surlignes et reessayez.",
  "desktop.settings.invalidSubmit":
    "Ces parametres de telechargement sont invalides. Ajustez-les et reessayez.",
  "desktop.output.deniedPick":
    "La destination d enregistrement n a pas ete acceptee. Choisissez un autre fichier pour continuer.",
  "desktop.output.exists":
    "Un fichier existe deja a la destination d enregistrement depuis {host}. Choisissez un autre fichier ou confirmez l ecrasement pour continuer.",
  "desktop.output.destDenied":
    "La destination d enregistrement n a pas ete acceptee depuis {host}. Choisissez un autre fichier pour continuer.",
  "desktop.job.gone":
    "Cette tache n est plus active depuis {host}. Recommencez avec une adresse recente.",
  "desktop.msg.thisPicture": "cette image",
  "desktop.msg.dimsPixels": "{a} par {b} pixels",
  "desktop.msg.needAbout": " Elle a besoin d environ {need} de memoire",
  "desktop.output.canvasLimit":
    "Cette image est trop grande pour etre assemblee sur cet ordinateur ({dims},{need} a 4 octets par pixel, limite {limit}). Enregistrez une version plus petite avec Largeur max (CLI : --max-width). Note : le JPEG accepte au plus {jpegMax} pixels par cote ; gardez le PNG pour les images plus grandes. Depuis {host}.",
  "desktop.output.jpegLimit":
    "Cette image ({dims}) est trop grande pour le JPEG, qui accepte au plus {jpegMax} pixels par cote. Enregistrez-la en PNG a la place. Depuis {host}.",
  "desktop.output.webpLimit":
    "Cette image ({dims}) est trop grande pour le WebP, qui accepte au plus {webpMax} pixels par cote. Enregistrez-la en PNG a la place. Depuis {host}.",
  "desktop.tile.partialDiscarded":
    "L image partielle a ete abandonnee, aucun fichier n a ete conserve. Reessayez depuis {host} avec une connexion stable.",
  "desktop.tile.partialChoice":
    "Certaines parties de cette image depuis {host} n ont pas pu etre enregistrees. Reessayez les parties manquees, ou conservez l image partielle avec des zones vides.",
  "view.discovery.none":
    "Aucune image zoomable trouvee a cette adresse. Essayez une page avec un visualiseur, ou essayez l extension.",
  "desktop.plan.none":
    "Cette image n a aucune taille utilisable a enregistrer depuis {host}. Essayez une autre image ou une Largeur max plus petite.",
  "desktop.transport.stalled":
    "Enregistrement bloque lors du contact avec {host}. Verifiez votre connexion et reessayez.",
  "desktop.output.writeFail":
    "Impossible d ecrire cette image depuis {host}. Choisissez une autre destination et reessayez.",
  "desktop.job.cancelledMsg":
    "L enregistrement de l image a ete interrompu. Tout fichier inacheve a ete supprime.",
  "desktop.start.failed":
    "Impossible de demarrer l enregistrement de cette image depuis {host}. Reessayez.",
  "desktop.choice.failed": "Ce choix n a pas ete accepte. Reessayez.",
  "desktop.internal.error":
    "Un probleme inattendu a interrompu cet enregistrement depuis {host}. Reessayez, et copiez les diagnostics si cela se reproduit.",
  "desktop.save.fallback": "Impossible d enregistrer cette image depuis {host}. Reessayez.",
  "desktop.invoke.startFallback": "Impossible de demarrer la tache.",
  "desktop.invoke.partial": "Le choix d image partielle a ete refuse.",
  "desktop.rec.missing": "Tuiles manquantes : {shown}{rest}.",
  "desktop.rec.more": " et {n} de plus",
  "desktop.rec.keep": "Conserver l image partielle",
  "desktop.rec.discard": "Abandonner la partie",
  "desktop.rec.retryTiles": "Reessayer les tuiles manquees",
  "desktop.rec.missingSome": "Certaines tuiles n ont pas pu etre enregistrees.",
  "desktop.rec.missingCount": "{count} tuile{plural} n ont pas pu etre enregistrees.",
  "desktop.rec.missingList": "{n} tuile{plural} manquante(s) : {shown}{rest}.",
  "desktop.done.partialTitle": "Image partielle enregistree",
  "desktop.done.partialDesc":
    "Ce fichier est marque comme partiel : {summary} Les zones manquantes restent vides. Cela le distingue d un enregistrement complet.",
  "desktop.cancel.note":
    "Enregistrement annule. Le nettoyage est termine et tout fichier inacheve a ete supprime.",
  "desktop.copy.diagnostics": "Copier les diagnostics",
  "desktop.copy.copied": "Copie !",
  "desktop.panel.jobActions": "Actions de la tache de bureau",
  "desktop.settings.reset": "Reinitialiser les parametres",
  "desktop.quick.folder": "Dossier",
  "desktop.quick.askEachTime": "Demander a chaque fois",
  "desktop.quick.chosenFolder": "Dossier choisi",
  "desktop.quick.chooseFolder": "Choisir le dossier de depart de la boite d enregistrement",
  "desktop.quick.format": "Format",
  "desktop.quick.size": "Taille",
  "desktop.quick.network": "Reseau",
  "desktop.quick.fast": "Rapide",
  "desktop.quick.balanced": "Equilibre · 5/s",
  "desktop.quick.gentle": "Doux · 2/s",
  "desktop.quick.fullResolution": "Resolution complete",
  "desktop.quick.upTo4k": "Jusqu a 4K",
  "desktop.quick.upTo2k": "Jusqu a 2K",
  "desktop.quick.custom": "Personnalise…",
  "desktop.quick.more": "Plus de reglages",
  "desktop.advanced.title": "Reglages avances",
  "desktop.advanced.done": "Termine",
  "desktop.advanced.jpegQuality": "Qualite JPEG",
  "desktop.advanced.jpegQualityDesc": "Une valeur plus elevee conserve davantage de details.",
  "desktop.advanced.compressionEffort": "Effort de compression",
  "desktop.advanced.compressionEffortDesc":
    "La qualite reste sans perte ; une valeur plus elevee prend plus de temps.",
  "desktop.advanced.dimensions": "Dimensions personnalisees",
  "desktop.advanced.dimensionsDesc":
    "Laissez une valeur vide pour conserver les proportions originales.",
  "desktop.advanced.width": "Largeur",
  "desktop.advanced.height": "Hauteur",
  "desktop.advanced.retries": "Essais",
  "desktop.advanced.retriesDesc":
    "Reessayer les tuiles echouees avant de conserver un resultat partiel.",
  "desktop.advanced.resumeCache": "Cache de reprise",
  "desktop.advanced.resumeCacheDesc": "Reutiliser les tuiles apres un enregistrement interrompu.",
  "desktop.advanced.choose": "Choisir…",
  "desktop.advanced.change": "Modifier…",
  "desktop.advanced.headers": "Entetes de requete",
  "desktop.advanced.headersDesc":
    "Pour les visionneuses protegees. Envoyees seulement a l origine de l image.",
  // Extension job-tab user copy, rendered through the same `t(key, vars)`
  // shape; log and diagnostics lines stay literal English and never use these
  // keys. `test/ui-i18n.test.mjs` fails when the page renders a key outside
  // this table.
} as const;
