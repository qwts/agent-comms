// Test-only fixed-name successor. Reuses the reviewed identity/allocation lab
// utilities; the legacy entrypoint is unreachable from this binary's main.
#define main unused_legacy_lab_main
#include "allocator.c"
#undef main
#include <CommonCrypto/CommonDigest.h>

static void digest(const unsigned char *bytes,size_t size,unsigned char out[32]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  need(size<=UINT_MAX && CC_SHA256(bytes,(CC_LONG)size,out)!=NULL,"sha256");
#pragma clang diagnostic pop
}
static void put(unsigned char *p,uint64_t value,size_t bytes) {
  for(size_t k=0;k<bytes;k++) {p[bytes-k-1]=(unsigned char)value;value>>=8;}
}
static void phase(const char *slot,const char *name,int durable) {
  printf("{\"event\":\"fixed-phase\",\"slot\":\"%s\",\"phase\":\"%s\","
    "\"durableFlushCompleted\":%s,\"acceptanceEstablished\":false}\n",
    slot,name,durable ? "true" : "false");fflush(stdout);
}
static size_t frame(size_t i,unsigned char bytes[33024]) {
  size_t cap=slots[i].payload,size=cap+256;
  memset(bytes,0,size);
  unsigned char *trailer=bytes+128+cap;
  memcpy(bytes,"ODJSLOT1",8);put(bytes+8,1,2);put(bytes+10,i+1,2);
  put(bytes+16,cap,4);put(bytes+20,cap,4);put(bytes+24,1,8);
  char preimage[256];
  // Synthetic namespace/request, not enrolled authority. Canonical sorted keys.
  int n=snprintf(preimage,sizeof preimage,
    "{\"namespaceDigest\":\"%s%s\",\"requestId\":\"00000000-0000-4000-8000-000000000077\","
    "\"slot\":\"%s\",\"v\":1}",nonce,nonce,slots[i].name);
  need(n>0 && (size_t)n<sizeof preimage,"context-preimage-bound");
  digest((const unsigned char *)preimage,(size_t)n,bytes+32);
  for(size_t k=0;k<cap;k++) bytes[128+k]=(unsigned char)(1+((k+i+1)%251));
  digest(bytes+128,cap,bytes+64);
  memcpy(trailer,"ODJCOM01",8);put(trailer+8,1,2);put(trailer+10,i+1,2);
  put(trailer+16,1,8);put(trailer+24,cap,4);memcpy(trailer+64,bytes+32,32);
  const char domain[]="owner-journal-frame-v1\n";
  unsigned char input[33024+sizeof domain];
  memcpy(input,domain,sizeof domain-1);memcpy(input+sizeof domain-1,bytes,128+cap);
  digest(input,sizeof domain-1+128+cap,trailer+32);
  return size;
}
static int fixed_open(size_t i,int flags) {
  char name[64];snprintf(name,sizeof name,"%s.record",slots[i].name);
  return open_slot(name,flags);
}
static void read_exact(int fd,unsigned char *bytes,size_t size) {
  struct stat st;if(fstat(fd,&st)) failure("fixed-fstat");
  need(st.st_size==(off_t)size && st.st_blocks*512>=(off_t)size,"fixed-capacity-length");
  size_t done=0;
  while(done<size) {
    ssize_t n=pread(fd,bytes+done,size-done,(off_t)done);
    if(n<0 && errno==EINTR) continue;
    if(n<=0) failure("fixed-pread");done+=(size_t)n;
  }
}
static void zeros(int fd,size_t i) {
  unsigned char bytes[33024];size_t size=slots[i].payload+256;
  read_exact(fd,bytes,size);
  for(size_t k=0;k<size;k++) need(bytes[k]==0,"fixed-not-initialized-zero");
}
static void verify_frame(int fd,size_t i,const char *label) {
  unsigned char expected[33024],observed[33024];size_t size=frame(i,expected);
  read_exact(fd,observed,size);
  need(!memcmp(expected,observed,size),"fixed-frame-content-digest-or-binding");
  report(fd,slots[i].name,label);
  printf("{\"event\":\"fixed-frame-verified\",\"slot\":\"%s\",\"bytes\":%zu,"
    "\"acceptanceEstablished\":false,\"authority\":false}\n",slots[i].name,size);
}
static void fixed_reserve(void) {
  const unsigned char bytes[33024]={0};
  for(size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    int fd=fixed_open(i,O_RDWR|O_CREAT|O_EXCL);
    fstore_t store={0};store.fst_flags=F_ALLOCATEALL|F_ALLOCATEPERSIST;
    store.fst_posmode=F_PEOFPOSMODE;store.fst_length=(off_t)(slots[i].payload+256);
    if(fcntl(fd,F_PREALLOCATE,&store)) failure("fixed-preallocate");
    need(store.fst_bytesalloc>=store.fst_length,"fixed-allocation-short");
    if(ftruncate(fd,store.fst_length)) failure("fixed-initial-truncate");
    write_all(fd,bytes,(size_t)store.fst_length,0);fullflush(fd);
    zeros(fd,i);report(fd,slots[i].name,"fixed-zero-initialized-fullflushed");close_checked(fd);
    fd=fixed_open(i,O_RDONLY);zeros(fd,i);report(fd,slots[i].name,"fixed-closed-reopened");close_checked(fd);
  }
  dirflush(journalfd);dirflush(mountfd);
  phase("all","fixed-directory-full-initialization-fsynced",1);
  printf("{\"event\":\"ready\",\"phase\":\"fixed-all-final-slots-closed\"}\n");fflush(stdout);
}
static void fixed_observe(int verify_zero,int verify_committed) {
  for(size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    int fd=fixed_open(i,O_RDONLY);
    if(verify_zero) zeros(fd,i);
    if(verify_committed) verify_frame(fd,i,"fixed-frame-read-only-verified");
    else report(fd,slots[i].name,verify_zero ? "fixed-zero-verified" : "fixed-observe");
    close_checked(fd);
  }
  struct statfs st;if(fstatfs(journalfd,&st)) failure("space-observe");
  printf("{\"event\":\"space\",\"blockSize\":%u,\"freeBlocks\":%llu,\"availableBlocks\":%llu}\n",
    st.f_bsize,(unsigned long long)st.f_bfree,(unsigned long long)st.f_bavail);
}
static void commit(size_t i,int crash) {
  int fd=fixed_open(i,O_RDWR);zeros(fd,i);
  unsigned char bytes[33024];size_t size=frame(i,bytes);
  write_all(fd,bytes,size-128,0);phase(slots[i].name,"body-written",0);
  fullflush(fd);phase(slots[i].name,"body-fullflushed",1);
  write_all(fd,bytes+size-128,128,(off_t)(size-128));
  phase(slots[i].name,"trailer-written-unflushed",0);
  if(crash) {
    printf("{\"event\":\"ready\",\"phase\":\"acceptance-trailer-written-before-fullflush\","
      "\"outcome\":\"uncertain\",\"acceptanceEstablished\":false}\n");fflush(stdout);
    for(;;) pause();
  }
  fullflush(fd);phase(slots[i].name,"trailer-fullflushed",1);
  verify_frame(fd,i,"fixed-committed-readback");close_checked(fd);
}
static void prefix(int recover) {
  // Only action and acceptance may be nonzero at this interrupted prefix.
  for(size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    int fd=fixed_open(i,recover ? O_RDWR : O_RDONLY);
    if(i==0 || i==1) {
      if(recover) {fullflush(fd);phase(slots[i].name,"explicit-recovery-fullflushed",1);}
      verify_frame(fd,i,recover ? "fixed-recovered-nonauthorizing" : "fixed-visible-uncertain");
    } else zeros(fd,i);
    close_checked(fd);
  }
  printf("{\"event\":\"fixed-prefix\",\"recoveryFlushCompleted\":%s,"
    "\"outcome\":\"%s\",\"acceptanceEstablished\":false,\"authority\":false}\n",
    recover ? "true" : "false",recover ? "verified-nonauthorizing" : "uncertain");
}
int main(int argc,char **argv) {
  setvbuf(stdout,NULL,_IOLBF,0);need(argc==4,"arguments");
  const char *op=argv[1];int reserving=!strcmp(op,"reserve-hold");
  need(reserving || !strcmp(op,"observe") || !strcmp(op,"verify-zero") || !strcmp(op,"fill")
    || !strcmp(op,"commit-crash") || !strcmp(op,"inspect-prefix") || !strcmp(op,"recover-prefix")
    || !strcmp(op,"commit-rest") || !strcmp(op,"verify"),"fixed-operation");
  setup(argv[2],argv[3],reserving);
  if(reserving) {fixed_reserve();for(;;) pause();}
  else if(!strcmp(op,"observe")) fixed_observe(0,0);
  else if(!strcmp(op,"verify-zero")) fixed_observe(1,0);
  else if(!strcmp(op,"fill")) fill();
  else if(!strcmp(op,"commit-crash")) {commit(1,0);commit(0,1);}
  else if(!strcmp(op,"inspect-prefix")) prefix(0);
  else if(!strcmp(op,"recover-prefix")) prefix(1);
  else if(!strcmp(op,"commit-rest")) {for(size_t i=2;i<sizeof slots/sizeof *slots;i++) commit(i,0);}
  else fixed_observe(0,1);
  close_checked(journalfd);close_checked(mountfd);return 0;
}
