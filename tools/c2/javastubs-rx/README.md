# javastubs-rx

reactor/WebFlux 最小桩(Flux/Mono/ServerWebExchange 等, 19 个 .class=逻辑 13 类)。

- 来源: 本地编译产物入库(上游源未随产线保留——CS27-3 记载为
  供给面债务); 与 `javastubs/`/`javastubs-jakarta/` 的 src+classes
  成对先例不同, 本目录仅 classes/。
- 再生成: 参照 `basetypes/RptStreamCoordinator.java` 用到的接口面
  (reactor.core.publisher.{Flux,Mono} + org.springframework.web.
  reactive.*)手写最小桩源后 `javac` 到本目录。
- 消费方: c2-javart.py RXSTUB / c2-functest.py RXSTUB(reactor 车道)。
