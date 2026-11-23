// Linked only by tests/wkwebview/run.sh. The release executable contains no QA bridge.
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

static void Record(NSDictionary *result) {
    NSURL *directory = [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory
                                                             inDomains:NSUserDomainMask].firstObject;
    [NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES
                                          attributes:nil error:nil];
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:nil];
    [json writeToURL:[directory URLByAppendingPathComponent:@"webkit-smoke.json"] atomically:YES];
}

static WKWebView *FindBrowser(UIView *view) {
    if ([view isKindOfClass:WKWebView.class]) return (WKWebView *)view;
    for (UIView *subview in view.subviews) {
        WKWebView *browser = FindBrowser(subview);
        if (browser) return browser;
    }
    return nil;
}

extern NSDictionary *SwiDeFolderSnapshot(NSURL *root, NSError **error);

static NSURL *CreateFolderFixture(NSError **error) {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSURL *base = [fm.temporaryDirectory URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
    NSURL *root = [base URLByAppendingPathComponent:@"FolderFixture" isDirectory:YES];
    NSURL *file = [root URLByAppendingPathComponent:@"Sources/Nested/Marker.swift"];
    NSURL *empty = [root URLByAppendingPathComponent:@"Empty" isDirectory:YES];
    if (![fm createDirectoryAtURL:file.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:error] ||
        ![fm createDirectoryAtURL:empty withIntermediateDirectories:YES attributes:nil error:error] ||
        ![@"let nativeFolderMarker = 4817\n" writeToURL:file atomically:YES encoding:NSUTF8StringEncoding error:error]) return nil;
    NSURL *link = [root URLByAppendingPathComponent:@"Alias.swift"];
    if (![fm createSymbolicLinkAtURL:link withDestinationURL:file error:error]) return nil;
    NSError *rejection = nil;
    if (SwiDeFolderSnapshot(root, &rejection) || !rejection) {
        if (error) *error = [NSError errorWithDomain:@"SwiDeFolderTest" code:1
            userInfo:@{NSLocalizedDescriptionKey:@"Native folder reader accepted a symlink."}];
        return nil;
    }
    return [fm removeItemAtURL:link error:error] ? root : nil;
}

// Supply the selected URL at the UIKit delegate boundary. The production picker,
// its message handler, reader and ZIP importer run normally; Files UI is not driven.
static void ChooseFixtureWhenPresented(UIViewController *host, NSURL *fixture, int attempts) {
    UIDocumentPickerViewController *picker = (id)host.presentedViewController;
    if ([picker isKindOfClass:UIDocumentPickerViewController.class] && picker.delegate == (id)host) {
        [picker.delegate documentPicker:picker didPickDocumentsAtURLs:@[fixture]];
        [picker dismissViewControllerAnimated:NO completion:nil];
        return;
    }
    if (attempts > 0) dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC / 8), dispatch_get_main_queue(), ^{
        ChooseFixtureWhenPresented(host, fixture, attempts - 1);
    });
}

static void Probe(int attempts);
static void Retry(int attempts) {
    if (attempts <= 0) {
        Record(@{@"passed":@NO, @"error":@"The embedded editor did not initialize on a file URL."});
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC/2), dispatch_get_main_queue(), ^{
        Probe(attempts - 1);
    });
}

static void Probe(int attempts) {
    UIWindow *window = UIApplication.sharedApplication.delegate.window;
    WKWebView *browser = FindBrowser(window.rootViewController.view);
    if (!browser || !browser.URL.isFileURL || ![browser.URL.lastPathComponent isEqualToString:@"index.html"] ||
        !browser.window || CGRectIsEmpty(browser.bounds) || browser.hidden) {
        Retry(attempts);
        return;
    }
    [browser evaluateJavaScript:@"Boolean(window.pocketIDE && document.querySelector('#code')?.value?.includes('SwiftUI'))"
              completionHandler:^(id ready, NSError *error) {
        if (error || ![ready respondsToSelector:@selector(boolValue)] || ![ready boolValue]) {
            Retry(attempts);
            return;
        }
        NSURL *url = [NSBundle.mainBundle URLForResource:@"Smoke" withExtension:@"js"];
        NSString *script = [NSString stringWithContentsOfURL:url encoding:NSUTF8StringEncoding error:nil];
        if (!script.length) {
            Record(@{@"passed":@NO, @"error":@"Missing test target script"});
            return;
        }
        NSError *fixtureError = nil;
        NSURL *fixture = CreateFolderFixture(&fixtureError);
        if (!fixture) {
            Record(@{@"passed":@NO, @"error":fixtureError.localizedDescription ?: @"Cannot create folder fixture"});
            return;
        }
        ChooseFixtureWhenPresented(window.rootViewController, fixture, 400);
        [browser callAsyncJavaScript:script arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
                   completionHandler:^(id result, NSError *err) {
            [NSFileManager.defaultManager removeItemAtURL:fixture.URLByDeletingLastPathComponent error:NULL];
            if (err || ![result isKindOfClass:NSDictionary.class]) {
                Record(@{@"passed":@NO, @"error":err.localizedDescription ?: @"Invalid test response",
                         @"reason":err.userInfo[@"WKJavaScriptExceptionMessage"] ?: err.localizedFailureReason ?: @""});
            } else {
                Record(result);
            }
        }];
    }];
}

@interface PocketSmokeObserver : NSObject
@end
@implementation PocketSmokeObserver
+ (void)load {
    [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidBecomeActiveNotification object:nil
            queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
        static dispatch_once_t once;
        dispatch_once(&once, ^{ Probe(180); });
    }];
}
@end
