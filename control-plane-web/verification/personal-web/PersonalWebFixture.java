package com.sage.business.code.bootstrap;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sage.business.code.adapter.http.BusinessHttpServer;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/** Actual ACS/Product with a loopback protocol model. Credentials stay on the parent pipe. */
public final class PersonalWebFixture {
  public static void main(String[] args) throws Exception {
    final ObjectMapper mapper = new ObjectMapper();
    final Path root = Paths.get(args[0]), workspace = Files.createDirectories(root.resolve("workspace"));
    Files.writeString(workspace.resolve("x.txt"), "v1");
    Files.writeString(workspace.resolve("y.txt"), "v1");
    Files.writeString(workspace.resolve("package.json"), "{\"name\":\"personal-web-fixture\",\"scripts\":{\"build\":\"node verify.cjs\",\"test\":\"node verify.cjs\",\"verify\":\"node verify.cjs\"}}");
    Files.writeString(workspace.resolve("verify.cjs"), Boolean.getBoolean("personal.fixture.writable") ? "for(const p of ['x.txt','y.txt'])if(require('fs').readFileSync(p,'utf8')!=='v2')process.exit(1);" : "if(!require('fs').existsSync('x.txt')) process.exit(1);");
    Files.createDirectories(workspace.resolve("node_modules"));
    Files.writeString(workspace.resolve("node_modules/.fixture"),"local protocol fixture");
    for (String[] command : Arrays.asList(new String[]{"init"}, new String[]{"config","core.longpaths","true"}, new String[]{"config","user.name","fixture"}, new String[]{"config","user.email","fixture@example.invalid"}, new String[]{"add","."}, new String[]{"commit","-m","baseline"})) {
      List<String> full = new ArrayList<>(Arrays.asList("git", "-C", workspace.toString())); full.addAll(Arrays.asList(command));
      Process p = new ProcessBuilder(full).redirectErrorStream(true).start(); p.getInputStream().readAllBytes();
      if (p.waitFor() != 0) throw new IOException("fixture git command failed");
    }
    final HttpServer model = HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
    final ExecutorService executor = Executors.newCachedThreadPool(); model.setExecutor(executor);
    // Optional deterministic gate (-Dpersonal.fixture.gate=<dir>): request n
    // writes request-<n> then blocks until allow-<n> appears, so the harness
    // can issue control commands with a model call deterministically in flight.
    final String gateDir = System.getProperty("personal.fixture.gate","");
    final java.util.concurrent.atomic.AtomicInteger modelSeq = new java.util.concurrent.atomic.AtomicInteger();
    model.createContext("/v1/chat/completions", exchange -> {
      try {
        JsonNode request = mapper.readTree(exchange.getRequestBody());
        boolean writable = Boolean.getBoolean("personal.fixture.writable");
        boolean child = writable && !request.path("tools").toString().contains("collaboration_control") && request.toString().contains("CHILD_WRITE_");
        if (!gateDir.isEmpty() && !child) {
          int seq = modelSeq.incrementAndGet();
          Path gates = Paths.get(gateDir); Files.createDirectories(gates);
          Files.writeString(gates.resolve("request-"+seq), "");
          Path allow = gates.resolve("allow-"+seq);
          long deadline = System.nanoTime()+120_000_000_000L;
          while (!Files.exists(allow) && System.nanoTime() < deadline)
            try { Thread.sleep(50); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
        }
        int prior = 0;
        for (JsonNode message : request.path("messages")) for (JsonNode call : message.path("tool_calls")) if (call.path("id").asText().startsWith("personal-web-")) prior++;
        ObjectNode answer = mapper.createObjectNode().put("role","assistant");
        if (prior < (writable && !child ? 3 : 2) && request.path("tools").isArray() && !request.path("tools").isEmpty()) {
          String file = child && request.toString().contains("CHILD_WRITE_Y") ? "y.txt" : "x.txt";
          ObjectNode toolArgs = mapper.createObjectNode().put("path",file);
          if (prior == 1 && (!writable || child)) toolArgs.putArray("edits").addObject().put("oldText","v1").put("newText","v2");
          answer.putArray("tool_calls").addObject().put("id","personal-web-"+UUID.randomUUID()).put("type","function")
            .putObject("function").put("name",prior == 1 && (!writable || child) ? "workspace_edit" : "workspace_read").put("arguments",toolArgs.toString());
        } else answer.put("content","Personal Web protocol model completed the requested edit of x.txt from v1 to v2.");
        boolean stream = request.path("stream").asBoolean();
        ObjectNode choice = mapper.createObjectNode().put("index",0).put("finish_reason",answer.has("tool_calls")?"tool_calls":"stop"); choice.set(stream?"delta":"message",answer);
        ObjectNode reply = mapper.createObjectNode().put("id","personal-web-response").put("model","fixture-model-response");reply.putArray("choices").add(choice);
        reply.putObject("usage").put("prompt_tokens",100).put("completion_tokens",20).put("total_tokens",120);
        String text = stream ? "data: "+reply+"\n\ndata: [DONE]\n\n" : reply.toString();
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type",stream?"text/event-stream":"application/json");
        exchange.sendResponseHeaders(200,bytes.length);exchange.getResponseBody().write(bytes);
      } finally { exchange.close(); }
    }); model.start();
    final String bearer = UUID.randomUUID().toString();
    ServiceConfig config = new ServiceConfig("127.0.0.1",1,bearer,root.resolve("state"),root.resolve("absent-model.properties"),
      Collections.singletonMap("sample",workspace.toString()),root.resolve("logs"),"WARN",false,false,4000,
      com.sage.business.code.adapter.product.ProcessExecutionSettings.disabled(),com.sage.business.code.adapter.product.TraceExportSettings.disabled(),"10MB",2,"20MB",
      "sample",Collections.singletonList("."),false,1,10,null,null,null,null,false,null,null,null,3000,null,null);
    // Ordinary host session: no collaboration, daemon or Docker. Foundation
    // stays off unless -Dpersonal.fixture.foundation=true opts in.
    config.collaborationWritableEnabled = Boolean.getBoolean("personal.fixture.writable");
    config.collaborationWritableDagEnabled = Boolean.getBoolean("personal.fixture.writable");
    config.collaborationThreeWayEnabled = Boolean.getBoolean("personal.fixture.writable");
    config.collaborationRepairEnabled = Boolean.getBoolean("personal.fixture.writable");
    config.collaborationAuxiliaryEnabled = Boolean.getBoolean("personal.fixture.collaboration");
    config.collaborationBoundaryEnabled = Boolean.getBoolean("personal.fixture.collaboration");
    config.collaborationHandoffEnabled = Boolean.getBoolean("personal.fixture.collaboration");
    config.sessionFoundationEnabled = Boolean.parseBoolean(System.getProperty("personal.fixture.foundation","false"));
    Properties catalog = new Properties();catalog.setProperty("PROVIDER_1_ID","fixture");catalog.setProperty("PROVIDER_1_DIALECT","OPENAI_CHAT_COMPLETIONS");
    catalog.setProperty("PROVIDER_1_BASE_URL","http://127.0.0.1:"+model.getAddress().getPort()+"/v1");catalog.setProperty("PROVIDER_1_API_KEY",UUID.randomUUID().toString());
    catalog.setProperty("PROVIDER_1_MODEL_1_ID","fixture-model");catalog.setProperty("PROVIDER_1_MODEL_1_CAPABILITIES","NATIVE_TOOL_CALLING");catalog.setProperty("MODEL_DEFAULT_MODEL","fixture-model");config.setCatalogFileProperties(catalog);
    BusinessServiceFactory.GuiServices services = BusinessServiceFactory.createGui(config);
    BusinessHttpServer server = new BusinessHttpServer(new InetSocketAddress("127.0.0.1",0),bearer,services.tasks,mapper,null,null,services.v2);server.start();
    java.lang.reflect.Field field = BusinessHttpServer.class.getDeclaredField("server");field.setAccessible(true);
    int port = ((HttpServer)field.get(server)).getAddress().getPort();
    // Parent must consume this private pipe; never persist the ready line.
    System.out.println("PERSONAL_WEB_READY "+mapper.createObjectNode().put("baseUrl","http://127.0.0.1:"+port).put("token",bearer).put("root",root.toString()));System.out.flush();
    new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8)).readLine();
    server.close(); if (services.catalogSynchronizer != null) services.catalogSynchronizer.close();services.tasks.close();model.stop(0);executor.shutdownNow();
  }
}
