#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <dirent.h>
#import <errno.h>
#import <fcntl.h>
#import <sys/stat.h>
#import <string.h>
#import <unistd.h>

static const NSUInteger FolderZipLimit = 20 * 1024 * 1024;
static const NSUInteger FolderFileLimit = 10 * 1024 * 1024;

static BOOL FolderFailure(NSError **error, NSString *message) {
    if (error) *error = [NSError errorWithDomain:@"SwiDeFolderImport" code:1
                                         userInfo:@{NSLocalizedDescriptionKey:message}];
    return NO;
}

// Uses openat/O_NOFOLLOW for every child of the chosen directory; file-provider
// changes during the read must not redirect it to another item.
static NSData *FolderFile(int parent, const char *name, struct stat expected) {
    int fd = openat(parent, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return nil;
    struct stat before, after;
    NSMutableData *data = nil;
    if (fstat(fd, &before) == 0 && S_ISREG(before.st_mode) &&
        before.st_dev == expected.st_dev && before.st_ino == expected.st_ino &&
        before.st_size == expected.st_size) {
        data = [NSMutableData dataWithLength:(NSUInteger)before.st_size];
        NSUInteger used = 0;
        while (used < data.length) {
            ssize_t count = read(fd, (char *)data.mutableBytes + used, data.length - used);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) { data = nil; break; }
            used += (NSUInteger)count;
        }
        if (fstat(fd, &after) != 0 || after.st_size != before.st_size ||
            after.st_mtimespec.tv_sec != before.st_mtimespec.tv_sec ||
            after.st_mtimespec.tv_nsec != before.st_mtimespec.tv_nsec) data = nil;
    }
    close(fd);
    return data;
}

static BOOL FolderEntries(int directory, NSString *prefix, NSMutableArray *files,
                          NSMutableArray *dirs, NSUInteger *zipBytes, NSError **error) {
    DIR *stream = fdopendir(directory); // takes ownership on success
    if (!stream) {
        close(directory);
        return FolderFailure(error, @"Nelze otevřít vybranou složku nebo její podsložku.");
    }
    BOOL success = YES;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(stream);
        if (!entry) {
            if (errno) success = FolderFailure(error, @"Výpis složky nebylo možné dokončit.");
            break;
        }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        NSString *name = [NSString stringWithUTF8String:entry->d_name];
        if (!name || [name containsString:@"\\"] || [name containsString:@":"] ||
            [name rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) {
            success = FolderFailure(error, @"Název položky nelze bezpečně uložit do ZIPu."); break;
        }
        NSString *path = prefix.length ? [prefix stringByAppendingFormat:@"/%@", name] : name;
        if (path.length > 1024 || dirs.count + files.count >= 2000) {
            success = FolderFailure(error, @"Projekt překročil limit 2 000 položek nebo délku cesty."); break;
        }
        struct stat item;
        if (fstatat(directory, entry->d_name, &item, AT_SYMLINK_NOFOLLOW) != 0) {
            success = FolderFailure(error, [@"Nelze přečíst položku: " stringByAppendingString:path]); break;
        }
        BOOL folder = S_ISDIR(item.st_mode);
        if (!folder && !S_ISREG(item.st_mode)) {
            success = FolderFailure(error, [@"Odkazy a speciální soubory nejsou podporovány: " stringByAppendingString:path]); break;
        }
        if (!folder && (item.st_size < 0 || (uint64_t)item.st_size > FolderFileLimit)) {
            success = FolderFailure(error, [@"Soubor překročil limit 10 MiB: " stringByAppendingString:path]); break;
        }
        NSUInteger nameBytes = [path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] + (folder ? 1 : 0);
        *zipBytes += 76 + 2 * nameBytes + (folder ? 0 : (NSUInteger)item.st_size);
        if (*zipBytes > FolderZipLimit) {
            success = FolderFailure(error, @"Složka překročila 20 MiB pro importovaný ZIP."); break;
        }
        if (folder) {
            int child = openat(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            struct stat actual;
            if (child < 0 || fstat(child, &actual) != 0 || actual.st_dev != item.st_dev || actual.st_ino != item.st_ino) {
                if (child >= 0) close(child);
                success = FolderFailure(error, [@"Nelze otevřít podsložku: " stringByAppendingString:path]); break;
            }
            [dirs addObject:path];
            if (!FolderEntries(child, path, files, dirs, zipBytes, error)) { success = NO; break; }
        } else {
            NSData *data = FolderFile(directory, entry->d_name, item);
            if (!data) {
                success = FolderFailure(error, [@"Nelze přečíst soubor. Ověř dostupnost v Souborech: " stringByAppendingString:path]); break;
            }
            [files addObject:@{@"path":path, @"base64":[data base64EncodedStringWithOptions:0]}];
        }
    }
    closedir(stream);
    return success;
}

NSDictionary *SwiDeFolderSnapshot(NSURL *root, NSError **error) {
    if (!root.isFileURL || !root.fileSystemRepresentation) {
        FolderFailure(error, @"Vyber složku v aplikaci Soubory."); return nil;
    }
    int directory = open(root.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0) { FolderFailure(error, @"Vybranou složku nelze otevřít."); return nil; }
    NSMutableArray *files = [NSMutableArray array], *dirs = [NSMutableArray array];
    NSUInteger zipBytes = 22;
    if (!FolderEntries(directory, @"", files, dirs, &zipBytes, error)) return nil;
    return @{@"name":root.lastPathComponent, @"files":files, @"dirs":dirs};
}


@interface PocketEditor : UIViewController <WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate>
@property(nonatomic, strong) WKWebView *browser;
@property(nonatomic, strong) NSURL *editorURL;
@property(nonatomic, copy) void (^folderReply)(id, NSString *);
@property(nonatomic, strong) UIDocumentPickerViewController *folderPicker;
@end

@implementation PocketEditor

- (void)showError:(NSString *)message {
    if (self.presentedViewController) return;
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"SwiDe"
        message:message preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = UIColor.systemBackgroundColor;
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = WKWebsiteDataStore.defaultDataStore;
    [configuration.userContentController addScriptMessageHandler:self name:@"exportProject"];
    [configuration.userContentController addScriptMessageHandler:self name:@"exportWorkspaceZip"];
    [configuration.userContentController addScriptMessageHandler:self name:@"exportVerifiedIPA"];
    [configuration.userContentController addScriptMessageHandlerWithReply:self contentWorld:WKContentWorld.pageWorld name:@"importFolder"];
    self.browser = [[WKWebView alloc] initWithFrame:CGRectZero configuration:configuration];
    self.browser.navigationDelegate = self;
    self.browser.UIDelegate = self;
    self.browser.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.browser];
    UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [self.browser.topAnchor constraintEqualToAnchor:guide.topAnchor],
        [self.browser.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor],
        [self.browser.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [self.browser.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor]
    ]];
    self.editorURL = [NSBundle.mainBundle URLForResource:@"index" withExtension:@"html"];
    if (self.editorURL) {
        [self.browser loadFileURL:self.editorURL allowingReadAccessToURL:self.editorURL];
    } else {
        [self.browser loadHTMLString:@"<p>Soubor editoru index.html chybí.</p>" baseURL:nil];
    }
}

- (BOOL)isEditorURL:(NSURL *)url {
    return url.isFileURL && self.editorURL &&
        [url.URLByStandardizingPath.path isEqualToString:self.editorURL.URLByStandardizingPath.path];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
 decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    if (action.targetFrame.isMainFrame && ([self isEditorURL:url] ||
        (!self.editorURL && [url.absoluteString isEqualToString:@"about:blank"]))) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    BOOL openExternal = action.sourceFrame.isMainFrame && (!action.targetFrame || action.targetFrame.isMainFrame) &&
        action.navigationType == WKNavigationTypeLinkActivated &&
        [url.scheme.lowercaseString isEqualToString:@"https"] && url.host.length;
    decisionHandler(WKNavigationActionPolicyCancel);
    if (openExternal) [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message
 initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    if (!frame.isMainFrame || ![self isEditorURL:frame.request.URL] || self.presentedViewController) {
        completionHandler();
        return;
    }
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"SwiDe" message:message
        preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *action) { completionHandler(); }]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
 initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    if (!frame.isMainFrame || ![self isEditorURL:frame.request.URL] || self.presentedViewController) {
        completionHandler(NO);
        return;
    }
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"SwiDe" message:message
        preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"Zrušit" style:UIAlertActionStyleCancel
        handler:^(UIAlertAction *action) { completionHandler(NO); }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Potvrdit" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *action) { completionHandler(YES); }]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
 defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame
 completionHandler:(void (^)(NSString *))completionHandler {
    if (!frame.isMainFrame || ![self isEditorURL:frame.request.URL] || self.presentedViewController) {
        completionHandler(nil);
        return;
    }
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"SwiDe" message:prompt
        preferredStyle:UIAlertControllerStyleAlert];
    [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.text = defaultText;
        field.autocapitalizationType = UITextAutocapitalizationTypeNone;
        field.autocorrectionType = UITextAutocorrectionTypeNo;
    }];
    UITextField *field = alert.textFields.firstObject;
    [alert addAction:[UIAlertAction actionWithTitle:@"Zrušit" style:UIAlertActionStyleCancel
        handler:^(UIAlertAction *action) { completionHandler(nil); }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *action) { completionHandler(field.text); }]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id, NSString *))replyHandler {
    if (![message.name isEqualToString:@"importFolder"] || !message.frameInfo.isMainFrame ||
        message.webView != self.browser || ![self isEditorURL:message.frameInfo.request.URL]) {
        replyHandler(nil, @"Požadavek nepochází z editoru."); return;
    }
    if (self.folderReply || self.presentedViewController) {
        replyHandler(nil, @"Nejdřív dokonči otevřený výběr."); return;
    }
    self.folderReply = replyHandler;
    self.folderPicker = [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeFolder] asCopy:NO];
    self.folderPicker.delegate = self;
    self.folderPicker.allowsMultipleSelection = NO;
    [self presentViewController:self.folderPicker animated:YES completion:nil];
    self.folderPicker.presentationController.delegate = self;
}

- (void)finishFolder:(id)value error:(NSString *)message {
    void (^reply)(id, NSString *) = self.folderReply;
    self.folderReply = nil;
    self.folderPicker = nil;
    if (reply) reply(value, message);
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
    if (controller == self.folderPicker) [self finishFolder:NSNull.null error:nil];
}
- (void)presentationControllerDidDismiss:(UIPresentationController *)presentationController {
    if (presentationController.presentedViewController == self.folderPicker) [self finishFolder:NSNull.null error:nil];
}
- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    if (controller != self.folderPicker || !self.folderReply) return;
    self.folderPicker = nil;
    NSURL *root = urls.firstObject;
    if (!root) { [self finishFolder:NSNull.null error:nil]; return; }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool {
            BOOL scoped = [root startAccessingSecurityScopedResource];
            NSError *coordinateError = nil;
            __block NSError *readError = nil;
            __block NSDictionary *result = nil;
            NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
            [coordinator coordinateReadingItemAtURL:root options:0 error:&coordinateError byAccessor:^(NSURL *url) {
                result = SwiDeFolderSnapshot(url, &readError);
            }];
            if (scoped) [root stopAccessingSecurityScopedResource];
            NSString *failure = readError.localizedDescription ?: coordinateError.localizedDescription;
            if (!result && !failure) failure = @"Složku nebylo možné přečíst.";
            dispatch_async(dispatch_get_main_queue(), ^{ [self finishFolder:result error:failure]; });
        }
    });
}

// WKWebView presents the system file picker for the editor's HTML file inputs on iOS.
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (message.webView != self.browser || !message.frameInfo.isMainFrame || ![self isEditorURL:message.frameInfo.request.URL] ||
        self.presentedViewController) return;

    NSData *data = nil;
    NSString *filename = nil;
    if ([message.name isEqualToString:@"exportProject"]) {
        if (![message.body isKindOfClass:NSString.class]) return;
        data = [(NSString *)message.body dataUsingEncoding:NSUTF8StringEncoding];
        if (!data.length || data.length > 4000000 ||
            ![[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] isKindOfClass:NSDictionary.class]) {
            [self showError:@"Export vyžaduje platný JSON projektu do velikosti 4 MB."];
            return;
        }
        filename = @"swide-project.json";
    } else if ([message.name isEqualToString:@"exportWorkspaceZip"] || [message.name isEqualToString:@"exportVerifiedIPA"]) {
        if (![message.body isKindOfClass:NSDictionary.class]) return;
        NSDictionary *payload = message.body;
        filename = payload[@"name"];
        NSString *encoded = payload[@"base64"];
        BOOL ipa = [message.name isEqualToString:@"exportVerifiedIPA"];
        NSString *extension = ipa ? @"ipa" : @"zip";
        NSUInteger maxBytes = (ipa ? 64 : 32) * 1024 * 1024;
        if (![filename isKindOfClass:NSString.class] || !filename.length || filename.length > 128 ||
            ![filename isEqualToString:filename.lastPathComponent] || [filename hasPrefix:@"."] ||
            [filename containsString:@"\\"] || ![filename.pathExtension.lowercaseString isEqualToString:extension] ||
            [filename rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound ||
            ![encoded isKindOfClass:NSString.class] || !encoded.length || encoded.length > ((maxBytes + 2) / 3) * 4) {
            [self showError:ipa ? @"Export ověřené IPA vyžaduje platný soubor do 64 MiB." : @"Export ZIP vyžaduje platný název a archiv do velikosti 32 MiB."];
            return;
        }
        data = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
        // The web exporter emits standard ZIP local headers (or an empty ZIP end record).
        const unsigned char *bytes = data.bytes;
        if (data.length < 22 || data.length > maxBytes || bytes[0] != 'P' || bytes[1] != 'K' ||
            !((bytes[2] == 3 && bytes[3] == 4) || (!ipa && bytes[2] == 5 && bytes[3] == 6))) {
            [self showError:@"Archiv ZIP se nepodařilo načíst."];
            return;
        }
    } else {
        return;
    }
    NSFileManager *manager = NSFileManager.defaultManager;
    NSURL *directory = [manager.temporaryDirectory URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
    NSURL *file = [directory URLByAppendingPathComponent:filename];
    NSError *error = nil;
    if (![manager createDirectoryAtURL:directory withIntermediateDirectories:NO attributes:nil error:&error] ||
        ![data writeToURL:file options:NSDataWritingAtomic error:&error]) {
        [manager removeItemAtURL:directory error:NULL];
        [self showError:error.localizedDescription ?: @"Soubor se nepodařilo uložit."];
        return;
    }
    UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:@[file] applicationActivities:nil];
    sheet.popoverPresentationController.sourceView = self.view;
    sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(self.view.bounds), CGRectGetMidY(self.view.bounds), 1, 1);
    sheet.completionWithItemsHandler = ^(UIActivityType activity, BOOL completed, NSArray *items, NSError *activityError) {
        [manager removeItemAtURL:directory error:NULL];
    };
    [self presentViewController:sheet animated:YES completion:nil];
}

@end

@interface PocketApplication : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation PocketApplication
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController = [[PocketEditor alloc] init];
    [self.window makeKeyAndVisible];
    return YES;
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass(PocketApplication.class));
    }
}
